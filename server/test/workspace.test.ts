import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

// workspace.js runs in the browser next to library.js; DOM rendering is stubbed
// out so the tab, save and conflict logic can be exercised directly.
const source = readFileSync(resolve(__dirname, "../../workspace.js"), "utf8").split("// --- startup ---")[0];

type Call = { path: string; method: string; body?: any };

function setup(stored?: object) {
  const calls: Call[] = [];
  const toasts: [string, boolean?][] = [];
  const asks: any[] = [];
  const answers: unknown[] = [];
  const storage = new Map<string, string>();
  if (stored) storage.set("pf_tabs_v1", JSON.stringify(stored));
  let nextVersion = 1;
  const server = new Map<string, any>();
  const context = createContext({
    setTimeout: () => 0, clearTimeout: () => {},
    crypto: { randomUUID: () => `id-${Math.random().toString(36).slice(2)}` },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) },
    window: { addEventListener() {} },
    input: { value: "", focus() {} },
    library: { folders: [{ id: "f-own", name: "Own", role: "owner" }, { id: "f-read", name: "Shared", role: "read" }], documents: [], loaded: true },
    openFolders: new Set(),
    libraryReady: Promise.resolve(),
    calls, toasts, asks, answers, server,
    nextVersion: () => ++nextVersion,
  });
  runInContext(`
    const canEditRole = role => role === "owner" || role === "edit" || role === "full";
    const folderById = id => library.folders.find(f => f.id === id);
    const libraryToast = (m, e) => toasts.push([m, e]);
    const libraryAsk = async options => { asks.push(options); return answers.shift(); };
    const rememberOpenFolders = () => {}, renderLibrary = () => {}, refreshLibrary = async () => {}, refreshLibrarySafely = async () => {};
    const render = () => {}, collapseInput = () => {}, expandInput = () => {}, switchTab = () => {};
    let editingInput = false;
    async function libraryApi(path, method = "GET", body) {
      calls.push({ path, method, body });
      if (path === "/folders") return { id: "f-new", name: body.name, role: "owner" };
      if (path === "/documents") { const doc = { id: "d" + calls.length, folderId: body.folderId, title: body.title, content: body.content, version: 1, role: "owner" }; server.set(doc.id, doc); return doc; }
      const id = path.split("/")[2];
      const doc = server.get(id);
      if (!doc) throw Object.assign(new Error("gone"), { status: 404 });
      if (method === "PATCH") {
        if (body.version !== doc.version) throw Object.assign(new Error("conflict"), { status: 409, code: "VERSION_CONFLICT" });
        Object.assign(doc, body, { version: doc.version + 1 });
      }
      return { ...doc };
    }
  `, context);
  runInContext(source, context);
  runInContext(`
    renderTabs = () => {}; updateTabChrome = () => {}; showTab = tab => { input.value = tab.content; };
    askSaveDestination = async options => { asks.push(options); return answers.shift(); };
    loadWorkspace();
  `, context);
  const run = (code: string) => runInContext(code, context);
  const type = (text: string) => { run(`input.value = ${JSON.stringify(text)}; workspaceInput();`); };
  return { run, type, calls, toasts, asks, answers, storage, server };
}

test("a fresh workspace has one empty draft that is not dirty", () => {
  const { run } = setup();
  assert.equal(run("workspace.tabs.length"), 1);
  assert.equal(run("isDirty(activeTab())"), false);
  assert.equal(run("tabTitle(activeTab())"), "متن تازه");
});

test("typing makes a dirty draft titled by its first line, kept across reloads", () => {
  const first = setup();
  first.type("## Heading\nbody");
  assert.equal(first.run("tabTitle(activeTab())"), "Heading");
  assert.equal(first.run("isDirty(activeTab())"), true);
  first.run("persistWorkspace(true)");
  const reloaded = setup(JSON.parse(first.storage.get("pf_tabs_v1")!));
  assert.equal(reloaded.run("activeTab().content"), "## Heading\nbody");
  assert.equal(reloaded.run("activeTab().doc"), null);
});

test("new text opens in a new tab unless the current one is empty", () => {
  const { run, type } = setup();
  run(`placeText("first")`);
  assert.equal(run("workspace.tabs.length"), 1);
  type("edited");
  run(`placeText("second")`);
  assert.equal(run("workspace.tabs.length"), 2);
  assert.equal(run("activeTab().content"), "second");
});

test("saving a draft asks for a destination, can create a folder, and links the tab", async () => {
  const { run, type, calls, answers } = setup();
  type("Draft text");
  answers.push({ title: "My doc", folderId: null, newFolderName: "Ideas" });
  await run("saveActiveTab()");
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ["POST /folders", "POST /documents"]);
  assert.equal(calls[1]!.body.folderId, "f-new");
  assert.equal(run("activeTab().doc.title"), "My doc");
  assert.equal(run("isDirty(activeTab())"), false);
});

test("cancelling the save dialog writes nothing", async () => {
  const { run, type, calls, answers } = setup();
  type("Draft text");
  answers.push(null);
  await run("saveActiveTab()");
  assert.equal(calls.length, 0);
  assert.equal(run("activeTab().doc"), null);
});

test("a saved tab saves edits with its version and skips clean saves", async () => {
  const { run, type, calls, answers, toasts } = setup();
  type("v1");
  answers.push({ title: "Doc", folderId: "f-own", newFolderName: null });
  await run("saveActiveTab()");
  await run("saveActiveTab()");
  assert.equal(calls.length, 1, "clean tab is not sent again");
  assert.match(toasts.at(-1)![0], /ذخیره شده/);
  type("v2");
  assert.equal(run("isDirty(activeTab())"), true);
  await run("saveActiveTab()");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { path: "/documents/d1", method: "PATCH", body: { content: "v2", version: 1 } });
  assert.equal(run("activeTab().doc.version"), 2);
  assert.equal(run("isDirty(activeTab())"), false);
});

test("persisted clean tabs store the body once; dirty tabs keep their saved baseline", async () => {
  const { run, type, answers, storage } = setup();
  type("saved body");
  answers.push({ title: "Doc", folderId: null, newFolderName: null });
  await run("saveActiveTab()");
  run("persistWorkspace(true)");
  let stored = JSON.parse(storage.get("pf_tabs_v1")!);
  assert.equal(stored.tabs[0].doc.content, undefined);
  type("unsaved edit");
  run("persistWorkspace(true)");
  stored = JSON.parse(storage.get("pf_tabs_v1")!);
  assert.equal(stored.tabs[0].doc.content, "saved body");
  const reloaded = setup(stored);
  assert.equal(reloaded.run("isDirty(activeTab())"), true);
});

test("a read-only document is saved as a personal copy", async () => {
  const { run, calls, answers, asks } = setup();
  run(`placeText("x"); activeTab().doc = { id: "shared", folderId: "f-read", title: "S", version: 3, content: "x", role: "read" };`);
  answers.push({ title: "Copy", folderId: null, newFolderName: null });
  await run("saveActiveTab()");
  assert.match(asks[0].description, /فقط خواندنی/);
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ["POST /documents"]);
  assert.equal(run("activeTab().doc.role"), "owner");
});

test("a conflict can open the newer version while keeping the edit as a draft", async () => {
  const { run, type, answers, server } = setup();
  type("mine v1");
  answers.push({ title: "Doc", folderId: null, newFolderName: null });
  await run("saveActiveTab()");
  server.get("d1").version = 5; server.get("d1").content = "theirs";
  type("mine v2");
  answers.push("open");
  await run("saveActiveTab()");
  assert.equal(run("workspace.tabs.length"), 2);
  assert.equal(run("workspace.tabs[0].doc"), null);
  assert.equal(run("workspace.tabs[0].content"), "mine v2");
  assert.equal(run("activeTab().content"), "theirs");
  assert.equal(run("activeTab().doc.version"), 5);
});

test("a conflict can overwrite with the user's text or save it separately", async () => {
  for (const choice of ["overwrite", "copy"]) {
    const { run, type, answers, server, calls } = setup();
    type("mine v1");
    answers.push({ title: "Doc", folderId: null, newFolderName: null });
    await run("saveActiveTab()");
    server.get("d1").version = 4;
    type("mine v2");
    answers.push(choice);
    if (choice === "copy") answers.push({ title: "Mine", folderId: null, newFolderName: null });
    await run("saveActiveTab()");
    if (choice === "overwrite") {
      assert.equal(server.get("d1").content, "mine v2");
      assert.equal(run("activeTab().doc.id"), "d1");
    } else {
      assert.equal(calls.at(-1)!.method, "POST");
      assert.notEqual(run("activeTab().doc.id"), "d1");
      assert.equal(server.get("d1").content, "mine v1");
    }
    assert.equal(run("isDirty(activeTab())"), false);
  }
});

test("a rename keeps unsaved edits and adopts the new version", () => {
  const { run, type } = setup();
  run(`placeText("base"); activeTab().doc = { id: "d", folderId: null, title: "Old", version: 1, content: "base", role: "owner" };`);
  type("edited");
  run(`workspaceDocumentUpdated({ id: "d", folderId: null, title: "New", version: 2, content: "base", role: "owner" })`);
  assert.equal(run("activeTab().content"), "edited");
  assert.equal(run("activeTab().doc.title"), "New");
  assert.equal(run("activeTab().doc.version"), 2);
  run(`workspaceDocumentUpdated({ id: "d", folderId: null, title: "New", version: 3, content: "someone else", role: "owner" })`);
  assert.equal(run("activeTab().doc.version"), 2, "a real content change must still surface as a conflict");
  assert.equal(run("activeTab().content"), "edited");
});

test("a clean tab follows the server copy; removed documents become drafts", () => {
  const { run } = setup();
  run(`placeText("base"); activeTab().doc = { id: "d", folderId: null, title: "T", version: 1, content: "base", role: "owner" };`);
  run(`workspaceDocumentUpdated({ id: "d", folderId: null, title: "T", version: 2, content: "updated", role: "owner" })`);
  assert.equal(run("activeTab().content"), "updated");
  run(`workspaceDocumentRemoved("d")`);
  assert.equal(run("activeTab().doc"), null);
  assert.equal(run("activeTab().content"), "updated");
});

test("clearing a saved tab opens a fresh tab instead of blanking it", () => {
  const { run } = setup();
  run(`placeText("keep"); activeTab().doc = { id: "d", folderId: null, title: "T", version: 1, content: "keep", role: "owner" };`);
  run("clearActiveTab()");
  assert.equal(run("workspace.tabs.length"), 2);
  assert.equal(run("workspace.tabs[0].content"), "keep");
  assert.equal(run("activeTab().content"), "");
});

test("logging out forgets saved tabs but keeps drafts", () => {
  const { run, type } = setup();
  type("draft");
  run(`placeText("saved"); activeTab().doc = { id: "d", folderId: null, title: "T", version: 1, content: "saved", role: "owner" };`);
  run("workspaceForgetSavedDocuments()");
  assert.deepEqual(JSON.parse(run("JSON.stringify(workspace.tabs.map(t => t.content))")), ["draft"]);
});

test("the date button opens one date tab and focuses it afterwards", () => {
  const { run, type } = setup();
  type("some text");
  run("openDateTab()");
  assert.equal(run("workspace.tabs.length"), 2);
  assert.equal(run("activeTab().kind"), "date");
  assert.equal(run("tabTitle(activeTab())"), "تبدیل تاریخ");
  assert.equal(run("isDirty(activeTab())"), false);
  run("selectTab(workspace.tabs[0].id); openDateTab()");
  assert.equal(run("workspace.tabs.length"), 2, "an existing date tab is reused");
  assert.equal(run("activeTab().kind"), "date");
});

test("new text never lands in the date tab", () => {
  const { run } = setup();
  run("openDateTab()");
  run(`placeText("pasted")`);
  assert.equal(run("activeTab().kind"), undefined);
  assert.equal(run("activeTab().content"), "pasted");
  run("openDateTab(); workspaceInput()");
  assert.equal(run(`workspace.tabs.find(t => t.kind === "date").content`), "");
});

test("the formatter button reuses an empty draft, otherwise opens a new text tab", () => {
  const { run, type } = setup();
  run("openFormatterTab()");
  assert.equal(run("workspace.tabs.length"), 1);
  type("text");
  run("openFormatterTab()");
  assert.equal(run("workspace.tabs.length"), 2);
  assert.equal(run("activeTab().content"), "");
});

test("the date tab survives a reload", () => {
  const first = setup();
  first.run("openDateTab(); persistWorkspace(true)");
  const reloaded = setup(JSON.parse(first.storage.get("pf_tabs_v1")!));
  assert.equal(reloaded.run(`workspace.tabs.filter(t => t.kind === "date").length`), 1);
});
