import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

const source = readFileSync(resolve(__dirname, "../../library.js"), "utf8")
  .replace("const libraryReady = initLibrary();", "const libraryReady = Promise.resolve();");

async function save(answers: (string | null)[], setup = "", failPath = "") {
  const calls: any[] = [];
  const prompts: any[] = [];
  const notices: any[] = [];
  const context = createContext({
    input: { value: "Text", focus() {} },
    ask: async (options: any) => { prompts.push(options); return answers.shift(); },
    api: async (path: string, method = "GET", body?: any, shared?: boolean) => {
      calls.push({ path, method, body, shared });
      if (path === failPath) throw new Error("Unavailable");
      if (path === "/library") return { folders: [{ id: "personal", name: "My folder" }] };
      if (path === "/folders") return { id: "created" };
      return { id: "saved", folder_id: body?.folderId, version: 1, ...body };
    },
    notice: (...args: any[]) => notices.push(args),
  });
  runInContext(source, context);
  runInContext(`libraryAsk = ask; libraryApi = api; libraryToast = notice; refreshLibrary = async () => {}; ${setup}`, context);
  await runInContext("saveCurrent()", context);
  return { calls, prompts, notices, context, answers };
}

test("save selects an existing folder or explicitly saves unfiled", async () => {
  for (const choice of ["personal", ""]) {
    const { calls } = await save(["Title", choice]);
    assert.equal(calls.at(-1).path, "/items");
    assert.equal(calls.at(-1).body.folderId, choice || null);
  }
});

test("save creates the requested folder before saving the text", async () => {
  const { calls } = await save(["Title", "new-folder", "New"]);
  assert.equal(calls[1].path, "/folders");
  assert.equal(calls[1].body.name, "New");
  assert.equal(calls[2].body.folderId, "created");
});

test("cancelling any save prompt does not write data", async () => {
  for (const answers of [[null], ["Title", null], ["Title", "new-folder", null]]) {
    const { calls } = await save(answers);
    assert.ok(calls.every(call => call.method === "GET"));
  }
});

test("existing text keeps its default folder and can move on save", async () => {
  const { calls, prompts } = await save(["Title", ""], 'activeSavedItem = { id: "existing", title: "Old", folder_id: "personal" };');
  assert.equal(prompts[1].value, "personal");
  assert.equal(calls.at(-1).path, "/items/existing");
  assert.equal(calls.at(-1).method, "PATCH");
  assert.equal(calls.at(-1).body.folderId, null);
});

test("read-only shared text is copied to a personal folder without its grant", async () => {
  const { calls, prompts } = await save(["Title", "personal"], 'sharedFolder = { folderId: "shared", access: "read" }; activeSavedItem = { id: "original", folder_id: "shared" };');
  assert.ok(prompts[1].options.some((option: any) => option.value === "personal"));
  assert.equal(calls.at(-1).path, "/items");
  assert.equal(calls.at(-1).shared, false);
});

test("full shared access only offers the shared folder and uses its grant", async () => {
  const { calls, prompts } = await save(["Title", "shared"], 'sharedFolder = { folderId: "shared", access: "full" }; libraryData.folders = [{ id: "shared", name: "Shared" }];');
  assert.equal(prompts[1].options.length, 1);
  assert.equal(prompts[1].value, "shared");
  assert.equal(calls.at(-1).shared, true);
});

test("a failed folder creation does not save the text", async () => {
  const { calls, notices } = await save(["Title", "new-folder", "New"], "", "/folders");
  assert.ok(calls.every(call => call.path !== "/items"));
  assert.equal(notices.at(-1)[1], true);
});

test("saving a read-only copy switches to personal scope and updates that copy next time", async () => {
  const run = await save(["Title", "personal"], 'sharedFolder = { folderId: "shared", access: "read" }; activeSavedItem = { id: "original", folder_id: "shared" };');
  run.answers.push("Updated", "personal");
  await runInContext("saveCurrent()", run.context);
  assert.equal(run.calls.filter(call => call.path === "/items" && call.method === "POST").length, 1);
  assert.equal(run.calls.at(-1).path, "/items/saved");
  assert.equal(run.calls.at(-1).method, "PATCH");
  assert.equal(run.calls.at(-1).body.version, 1);
  assert.equal(run.prompts.at(-1).value, "personal");
});

test("moving the open text updates the next save destination", async () => {
  const run = await save([null], 'activeSavedItem = { id: "existing", title: "Old", folder_id: "old", version: 2 }; libraryData.folders = [{ id: "personal", name: "New" }]; libraryNotice = notice;');
  run.answers.push("personal");
  await runInContext("moveSavedItem(activeSavedItem)", run.context);
  run.answers.push("Title", "personal");
  await runInContext("saveCurrent()", run.context);
  assert.equal(run.prompts.at(-1).value, "personal");
  assert.equal(run.calls.at(-1).body.folderId, "personal");
});

test("refresh failure after a successful save is not reported as a failed save", async () => {
  const { calls, notices } = await save(["Title", ""], 'refreshLibrary = async () => { throw new Error("offline"); };');
  assert.equal(calls.at(-1).path, "/items");
  assert.notEqual(notices.at(-1)[1], true);
  assert.match(notices.at(-1)[0], /ذخیره شد/);
});

test("conflict preserves the editor and can save a separate personal copy", async () => {
  const run = await save(["Title", "personal", "yes"], `
    activeSavedItem = { id: "existing", title: "Old", folder_id: "personal", version: 1 };
    const originalApi = libraryApi;
    libraryApi = async (...args) => { if (args[1] === "PATCH") throw Object.assign(new Error("Conflict"), { code: "VERSION_CONFLICT" }); return originalApi(...args); };
  `);
  assert.equal(run.calls.at(-1).path, "/items");
  assert.equal(run.calls.at(-1).body.content, "Text");
  assert.equal(run.calls.at(-1).body.folderId, null);
  assert.equal(runInContext("input.value", run.context), "Text");
});

test("declining a conflict copy keeps the draft without overwriting the server", async () => {
  const run = await save(["Title", "personal", null], `
    activeSavedItem = { id: "existing", title: "Old", folder_id: "personal", version: 1 };
    const originalApi = libraryApi;
    libraryApi = async (...args) => { if (args[1] === "PATCH") throw Object.assign(new Error("Conflict"), { code: "VERSION_CONFLICT" }); return originalApi(...args); };
  `);
  assert.equal(run.calls.filter(call => call.method !== "GET").length, 0);
  assert.equal(runInContext("input.value", run.context), "Text");
});

test("expired grant is renewed once and the original request retried", async () => {
  const requests: string[] = [];
  const context = createContext({
    fetch: async (url: string) => {
      requests.push(url);
      const renewal = url.includes("redeem");
      const ok = renewal || requests.length > 1;
      return { ok, status: ok ? 200 : 403, json: async () => renewal ? { grant: "new", folderId: "folder", access: "edit" } : { items: [] } };
    },
    sessionStorage: { setItem() {} },
  });
  runInContext(source, context);
  runInContext('sharedFolder = { folderId: "folder", linkToken: "link", access: "edit", grant: "expired" };', context);
  await runInContext('libraryApi("/folders/folder", "GET", undefined, true)', context);
  assert.deepEqual(requests, ["/api/folders/folder", "/api/folder-links/link/redeem", "/api/folders/folder"]);
});
