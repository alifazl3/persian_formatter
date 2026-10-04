import assert from "node:assert/strict";
import { randomUUID, createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate";
import { createAuthRouter, type AuthRouter } from "../src/auth";
import { createLibraryRouter, cleanupLibrary } from "../src/library";
import { errorHandler } from "../src/middleware/errorHandler";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("folder sharing against PostgreSQL", async t => {
  const admin = new Pool({ connectionString });
  const schema = `audit_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const app = express(); app.use(express.json());
  const auth = createAuthRouter(pool) as AuthRouter;
  app.use("/api", auth); app.use("/api", createLibraryRouter(pool, auth, 200000)); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  function client() {
    const cookies = new Map<string, string>();
    return async (path: string, method = "GET", body?: unknown, grant?: string, link?: string) => {
      const headers: Record<string, string> = { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (grant) headers["X-Folder-Grant"] = grant;
      if (link) headers["X-Folder-Link"] = link;
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const raw of res.headers.getSetCookie()) {
        const pair = raw.split(";")[0]!; const at = pair.indexOf("=");
        cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
      return { status: res.status, data: await res.json().catch(() => null) as any };
    };
  }
  try {
    await migrate(pool); await migrate(pool); // Migration must be safe on restart.
    const owner = client(), reader = client(), editor = client(), stranger = client();
    for (const who of [owner, reader, editor, stranger]) assert.equal((await who("/identity")).status, 200);
    const folder = (await owner("/folders", "POST", { name: "Shared" })).data;
    const privateFolder = (await owner("/folders", "POST", { name: "Private" })).data;
    const item = (await owner("/items", "POST", { title: "Original", content: "Original", folderId: folder.id })).data;
    async function link(access: string, singleUse = false) {
      const res = await owner(`/folders/${folder.id}/links`, "POST", { access, singleUse, label: "Test link", expiresInDays: 7 });
      assert.equal(res.status, 201); return res.data.token as string;
    }
    const readToken = await link("read");
    const editToken = await link("edit");
    const read = (await reader(`/folder-links/${readToken}/redeem`, "POST")).data;
    const edit = (await editor(`/folder-links/${editToken}/redeem`, "POST")).data;

    await t.test("read-only access blocks every mutation and other folders", async () => {
      for (const [path, method, body] of [
        [`/items/${item.id}`, "PATCH", { content: "bad", version: 1 }],
        [`/items/${item.id}`, "DELETE", undefined],
        ["/items", "POST", { title: "bad", content: "bad", folderId: folder.id }],
        [`/folders/${folder.id}`, "PATCH", { name: "bad" }],
        [`/folders/${folder.id}`, "DELETE", undefined],
        [`/folders/${folder.id}/links`, "POST", { access: "full", singleUse: false }],
        [`/folders/${privateFolder.id}`, "GET", undefined],
      ] as const) assert.equal((await reader(path, method, body, read.grant, readToken)).status, 403);
    });
    await t.test("edit access allows text edits but not folder management or link issuance", async () => {
      assert.equal((await editor(`/items/${item.id}`, "PATCH", { content: "Edited", version: 1 }, edit.grant, editToken)).status, 200);
      for (const method of ["PATCH", "DELETE"]) assert.equal((await editor(`/folders/${folder.id}`, method, method === "PATCH" ? { name: "bad" } : undefined, edit.grant, editToken)).status, 403);
      assert.equal((await editor(`/folders/${folder.id}/links`, "POST", { access: "full", singleUse: false }, edit.grant)).status, 403);
    });
    await t.test("two saves of the same version yield one success and one conflict", async () => {
      const responses = await Promise.all([
        owner(`/items/${item.id}`, "PATCH", { content: "Owner update", version: 2 }),
        editor(`/items/${item.id}`, "PATCH", { content: "Editor update", version: 2 }, edit.grant, editToken),
      ]);
      assert.deepEqual(responses.map(x => x.status).sort(), [200, 409]);
    });
    await t.test("concurrent rename and content change preserve both changes", async () => {
      const results = await Promise.all([
        owner(`/items/${item.id}`, "PATCH", { title: "New title" }),
        editor(`/items/${item.id}`, "PATCH", { content: "New body", version: 3 }, edit.grant, editToken),
      ]);
      assert.equal(results[0].status, 200);
      assert.ok([200, 409].includes(results[1].status));
      const stored = (await pool.query("SELECT * FROM saved_items WHERE id=$1", [item.id])).rows[0];
      assert.equal(stored.title, "New title");
      if (results[1].status === 200) assert.equal(stored.content, "New body");
      assert.equal((await owner(`/items/${item.id}`, "PATCH", { content: "No version" })).status, 428);
    });
    await t.test("a waiting shared write cannot move a newly private item back or delete it", async () => {
      const lock = await pool.connect();
      await lock.query("BEGIN");
      await lock.query("SELECT 1 FROM saved_items WHERE id=$1 FOR UPDATE", [item.id]);
      const pending = editor(`/items/${item.id}`, "PATCH", { title: "Late edit" }, edit.grant, editToken);
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT owner_id,folder_id,version%'");
        if (waiting.rowCount) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!blocked) { await lock.query("ROLLBACK"); lock.release(); await pending; assert.fail("Shared request did not wait for the item lock"); }
      await lock.query("UPDATE saved_items SET folder_id=$1,version=version+1 WHERE id=$2", [privateFolder.id, item.id]);
      await lock.query("COMMIT"); lock.release();
      assert.equal((await pending).status, 403);
      assert.equal((await editor(`/items/${item.id}`, "DELETE", undefined, edit.grant, editToken)).status, 403);
      assert.equal((await pool.query("SELECT folder_id FROM saved_items WHERE id=$1", [item.id])).rows[0].folder_id, privateFolder.id);
    });
    await t.test("concurrent transactions do not exhaust the connection pool", { timeout: 5000 }, async () => {
      const results = await Promise.all(Array.from({ length: 15 }, (_, i) => owner(`/items/${item.id}`, "PATCH", { title: `Rename ${i}` })));
      assert.ok(results.every(result => result.status === 200));
    });
    await t.test("single-use preview does not consume, owner preview bypasses consumption", async () => {
      const raw = await link("read", true);
      const info = await owner(`/folder-links/${raw}`);
      assert.equal(info.data.owner, true);
      assert.equal((await stranger(`/folder-links/${raw}`)).status, 200);
      assert.equal((await pool.query("SELECT use_count FROM folder_links WHERE token_hash=$1", [hash(raw)])).rows[0].use_count, 0);
    });
    await t.test("single-use link is consumed once across different browser sessions", async () => {
      const raw = await link("read", true);
      const results = await Promise.all([reader(`/folder-links/${raw}/redeem`, "POST"), stranger(`/folder-links/${raw}/redeem`, "POST")]);
      assert.deepEqual(results.map(x => x.status).sort(), [200, 410]);
    });
    await t.test("single-use retry/new tab in same session resumes without consuming again", async () => {
      const raw = await link("read", true);
      const first = await reader(`/folder-links/${raw}/redeem`, "POST");
      const second = await reader(`/folder-links/${raw}/redeem`, "POST");
      assert.equal(first.status, 200); assert.equal(second.status, 200);
      assert.equal((await reader(`/folders/${folder.id}`, "GET", undefined, first.data.grant, raw)).status, 200);
      assert.equal((await reader(`/folder-links/${raw}`)).data.resumed, true);
      assert.equal((await pool.query("SELECT use_count FROM folder_links WHERE token_hash=$1", [hash(raw)])).rows[0].use_count, 1);
    });
    await t.test("new grants are session-bound and cannot be replayed in another browser", async () => {
      assert.equal((await stranger(`/folders/${folder.id}`, "GET", undefined, read.grant, readToken)).status, 403);
      const anonymous = client();
      assert.equal((await anonymous(`/folder-links/${readToken}/redeem`, "POST")).status, 401);
    });
    await t.test("expired multi-use grant can renew; expired link cannot", async () => {
      await pool.query("UPDATE folder_grants SET expires_at=now()-interval '1 second' WHERE link_hash=$1", [hash(readToken)]);
      assert.equal((await reader(`/folders/${folder.id}`, "GET", undefined, read.grant, readToken)).status, 403);
      assert.equal((await reader(`/folder-links/${readToken}/redeem`, "POST")).status, 200);
      await pool.query("UPDATE folder_links SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [hash(readToken)]);
      assert.equal((await reader(`/folder-links/${readToken}/redeem`, "POST")).data.error.code, "LINK_EXPIRED");
      assert.equal((await reader(`/folders/${folder.id}`, "GET", undefined, undefined, readToken)).status, 403);
    });
    await t.test("revoking a link removes grants and prevents all future access", async () => {
      assert.equal((await owner(`/folders/${folder.id}/links/${hash(editToken)}`, "DELETE")).status, 204);
      assert.equal((await editor(`/folders/${folder.id}`, "GET", undefined, edit.grant, editToken)).status, 403);
      assert.equal((await editor(`/folder-links/${editToken}/redeem`, "POST")).data.error.code, "LINK_UNAVAILABLE");
      assert.equal((await pool.query("SELECT 1 FROM folder_grants WHERE link_hash=$1", [hash(editToken)])).rowCount, 0);
    });
    await t.test("link labels, creation, expiry and usage dates are returned", async () => {
      const links = (await owner(`/folders/${folder.id}/links`)).data.links;
      assert.ok(links.some((l: any) => l.label === "Test link" && l.created_at && l.expires_at && l.last_used_at));
    });
    await t.test("guest access survives passkey login and ends on logout", async () => {
      const guest = client(); await guest("/identity");
      const raw = await link("read", true);
      const granted = (await guest(`/folder-links/${raw}/redeem`, "POST")).data;
      const accountId = randomUUID(); const email = "login@example.test"; const credentialId = randomUUID();
      const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      await pool.query("INSERT INTO owners(id,email) VALUES($1,$2)", [accountId, email]);
      await pool.query("INSERT INTO webauthn_credentials(id,owner_id,public_key,sign_count) VALUES($1,$2,$3,0)", [credentialId, accountId, publicKey.export({ format: "jwk" })]);
      const options = (await guest("/auth/login/options", "POST", { email })).data;
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: new URL(base).origin }));
      const authData = Buffer.alloc(37);
      createHash("sha256").update(new URL(base).hostname).digest().copy(authData); authData[32] = 5; authData.writeUInt32BE(1, 33);
      const signed = Buffer.concat([authData, createHash("sha256").update(clientData).digest()]);
      const login = await guest("/auth/login/verify", "POST", { id: credentialId, response: {
        clientDataJSON: clientData.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: sign("sha256", signed, privateKey).toString("base64url"),
      } });
      assert.equal(login.status, 200);
      assert.equal((await guest(`/folders/${folder.id}`, "GET", undefined, granted.grant, raw)).status, 200);
      assert.equal((await guest(`/folder-links/${raw}`)).data.resumed, true);
      await guest("/auth/logout", "POST");
      assert.equal((await guest(`/folders/${folder.id}`, "GET", undefined, granted.grant, raw)).status, 403);
    });
    await t.test("full management still supports deleting folders; contents survive", async () => {
      const raw = await link("full");
      const manager = (await editor(`/folder-links/${raw}/redeem`, "POST")).data;
      const created = (await editor("/items", "POST", { title: "Managed", content: "Text", folderId: folder.id }, manager.grant, raw)).data;
      assert.equal((await editor(`/folders/${folder.id}`, "DELETE", undefined, manager.grant, raw)).status, 204);
      assert.equal((await pool.query("SELECT folder_id FROM saved_items WHERE id=$1", [created.id])).rows[0].folder_id, null);
    });
    await t.test("cleanup removes expired grants and challenge/rate records", async () => {
      await pool.query("UPDATE library_rate_limits SET window_start=now()-interval '2 hours'");
      await cleanupLibrary(pool);
      assert.equal((await pool.query("SELECT 1 FROM folder_grants WHERE expires_at<=now()")).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM library_rate_limits")).rowCount, 0);
    });
    await t.test("link creation rate and per-folder quota are enforced", async () => {
      const who = (await pool.query("SELECT owner_id FROM folders WHERE id=$1", [privateFolder.id])).rows[0].owner_id;
      await pool.query("INSERT INTO library_rate_limits VALUES($1,date_trunc('minute',now()),20)", [`create:${who}`]);
      assert.equal((await owner(`/folders/${privateFolder.id}/links`, "POST", { access: "read", singleUse: false })).status, 429);
      await pool.query("DELETE FROM library_rate_limits");
      for (let i = 0; i < 50; i++) await pool.query("INSERT INTO folder_links(token_hash,folder_id,access) VALUES($1,$2,'read')", [hash(String(i)), privateFolder.id]);
      assert.equal((await owner(`/folders/${privateFolder.id}/links`, "POST", { access: "read", singleUse: false })).data.error.code, "LINK_LIMIT");
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
