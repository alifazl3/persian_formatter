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
      return { id: "saved", folder_id: body?.folderId, ...body };
    },
    notice: (...args: any[]) => notices.push(args),
  });
  runInContext(source, context);
  runInContext(`libraryAsk = ask; libraryApi = api; libraryToast = notice; refreshLibrary = async () => {}; ${setup}`, context);
  await runInContext("saveCurrent()", context);
  return { calls, prompts, notices };
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
