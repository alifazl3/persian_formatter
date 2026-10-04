import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";
import type { AuthRouter } from "../src/auth";
import { createLibraryRouter } from "../src/library";

const ownerId = randomUUID();
const visitorId = randomUUID();
const folderId = randomUUID();
const itemId = randomUUID();
const grantToken = "g".repeat(43);
const grantHash = createHash("sha256").update(grantToken).digest("hex");

type Query = { sql: string; values: unknown[] };
type FakeDb = {
  queries: Query[];
  access: "read" | "full" | null;
  connect: () => Promise<any>;
  release: () => void;
  query: (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
};

function fakeDb(): FakeDb {
  const db: FakeDb = {
    queries: [],
    access: null,
    connect: async () => db,
    release() {},
    async query(sql, values = []) {
      db.queries.push({ sql, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT 1 FROM folders")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM folder_grants")) return { rows: db.access && values[0] === grantHash ? [{ folder_id: folderId, access: db.access }] : [], rowCount: db.access ? 1 : 0 };
      if (sql.includes("SELECT owner_id FROM folders")) return { rows: [{ owner_id: ownerId }], rowCount: 1 };
      if (sql.includes("SELECT owner_id,folder_id,version FROM saved_items")) return { rows: [{ owner_id: ownerId, folder_id: folderId, version: 1, title: "Old", content: "Old text" }], rowCount: 1 };
      if (sql.includes("UPDATE saved_items SET")) return { rows: [{ id: itemId, folder_id: folderId, title: "Old", content: values[1] }], rowCount: 1 };
      if (sql.includes("INSERT INTO saved_items")) return { rows: [{ id: itemId, folder_id: values[2], title: values[3], content: values[4] }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return db;
}

async function call(db: FakeDb, method: "post" | "patch", path: string, body: object, withGrant = false) {
  const auth = { principal: async () => ({ id: visitorId, email: null }) } as unknown as AuthRouter;
  const router = createLibraryRouter(db as unknown as Pool, auth, 200000);
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path && entry.route.methods[method]);
  assert.ok(layer, `Route ${method.toUpperCase()} ${path} exists`);
  const handler = layer.route.stack[0].handle;
  const req = {
    body,
    headers: {},
    params: path.includes(":id") ? { id: itemId } : {},
    get: (header: string) => header === "X-Folder-Grant" && withGrant ? grantToken : undefined,
  };
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const response: { statusCode: number; body?: any; status: (code: number) => any; json: (body: any) => any } = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; finish(); return this; },
  };
  let error: unknown;
  handler(req, response, (caught: unknown) => { error = caught; finish(); });
  await completed;
  return { response, error };
}

test("guest saves an unfiled text in the guest library", async () => {
  const db = fakeDb();
  const { response, error } = await call(db, "post", "/items", { title: "Test", content: "Persian text", folderId: null });
  assert.equal(error, undefined);
  assert.equal(response.statusCode, 201);
  const insert = db.queries.find(q => q.sql.includes("INSERT INTO saved_items"));
  assert.deepEqual(insert?.values.slice(1, 3), [visitorId, null]);
});

test("read-only grant cannot add or edit a folder item", async () => {
  const db = fakeDb(); db.access = "read";
  const create = await call(db, "post", "/items", { title: "Test", content: "Text", folderId }, true);
  assert.equal((create.error as any)?.statusCode, 403);
  const edit = await call(db, "patch", "/items/:id", { content: "Changed", version: 1 }, true);
  assert.equal((edit.error as any)?.statusCode, 403);
  assert.equal(db.queries.some(q => q.sql.includes("INSERT INTO saved_items") || q.sql.includes("UPDATE saved_items SET")), false);
});

test("full grant can add and edit items owned by the folder owner", async () => {
  const db = fakeDb(); db.access = "full";
  const create = await call(db, "post", "/items", { title: "Test", content: "Text", folderId }, true);
  assert.equal(create.error, undefined);
  assert.equal(create.response.statusCode, 201);
  const insert = db.queries.find(q => q.sql.includes("INSERT INTO saved_items"));
  assert.deepEqual(insert?.values.slice(1, 3), [ownerId, folderId]);
  const edit = await call(db, "patch", "/items/:id", { content: "Changed", version: 1 }, true);
  assert.equal(edit.error, undefined);
  assert.equal(edit.response.body.content, "Changed");
});
