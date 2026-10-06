import assert from "node:assert/strict";
import { randomUUID, createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate";
import { createAuthRouter, type AuthRouter } from "../src/auth";
import { PgLibraryRepository } from "../src/repositories/libraryRepository";
import { LibraryService } from "../src/services/libraryService";
import { createLibraryRouter } from "../src/handlers/libraryHandler";
import { errorHandler } from "../src/middleware/errorHandler";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("documents, folders and folder sharing against PostgreSQL", async t => {
  const admin = new Pool({ connectionString });
  const schema = `audit_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const service = new LibraryService(new PgLibraryRepository(pool), 200000);
  const app = express(); app.use(express.json());
  const auth = createAuthRouter(pool) as AuthRouter;
  app.use("/api", auth); app.use("/api", createLibraryRouter(service, auth)); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  function client() {
    const cookies = new Map<string, string>();
    const call = async (path: string, method = "GET", body?: unknown) => {
      const headers: Record<string, string> = { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const raw of res.headers.getSetCookie()) {
        const pair = raw.split(";")[0]!; const at = pair.indexOf("=");
        cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
      return { status: res.status, data: await res.json().catch(() => null) as any };
    };
    return Object.assign(call, { cookies });
  }
  try {
    await migrate(pool); await migrate(pool); // Migration must be safe on restart.
    const owner = client(), reader = client(), editor = client(), stranger = client();
    for (const who of [owner, reader, editor, stranger]) assert.equal((await who("/identity")).status, 200);
    const folder = (await owner("/folders", "POST", { name: "Shared" })).data;
    const privateFolder = (await owner("/folders", "POST", { name: "Private" })).data;
    const doc = (await owner("/documents", "POST", { title: "Original", content: "Original", folderId: folder.id })).data;
    async function link(access: string, singleUse = false, target = folder.id) {
      const res = await owner(`/folders/${target}/links`, "POST", { access, singleUse, label: "Test link", expiresInDays: 7 });
      assert.equal(res.status, 201); return res.data.token as string;
    }
    const readToken = await link("read");
    const editToken = await link("edit");

    await t.test("library lists metadata only, folders with role and counts", async () => {
      const unfiled = (await owner("/documents", "POST", { title: "Loose", content: "Loose text", folderId: null })).data;
      const library = (await owner("/library")).data;
      assert.deepEqual(library.folders.map((f: any) => [f.name, f.role]), [["Private", "owner"], ["Shared", "owner"]]);
      assert.equal(library.folders.find((f: any) => f.id === folder.id).documentCount, 1);
      assert.ok(library.documents.some((d: any) => d.id === unfiled.id && d.folderId === null));
      assert.ok(library.documents.every((d: any) => d.content === undefined));
      const full = (await owner(`/documents/${unfiled.id}`)).data;
      assert.equal(full.content, "Loose text"); assert.equal(full.role, "owner");
      assert.equal((await stranger(`/documents/${unfiled.id}`)).status, 404);
    });

    await t.test("search finds titles and text the user can open, folding ي/ك", async () => {
      await owner("/documents", "POST", { title: "یادداشت شبکه", content: "کارت شبکه را با دستور ip پیدا کن. " + "x".repeat(200) + " کلمهٔ نادر در انتها" });
      const byText = (await owner("/library/search?q=" + encodeURIComponent("كلمهٔ نادر"))).data.results;
      assert.equal(byText.length, 1);
      assert.match(byText[0].snippet, /^…/);
      assert.match(byText[0].snippet, /کلمهٔ نادر/);
      const byTitle = (await owner("/library/search?q=" + encodeURIComponent("يادداشت"))).data.results;
      assert.equal(byTitle[0].title, "یادداشت شبکه");
      assert.equal((await stranger("/library/search?q=" + encodeURIComponent("کلمهٔ نادر"))).data.results.length, 0);
      assert.equal((await owner("/library/search?q=a")).status, 400);
    });

    await t.test("joining makes the visitor a member; the folder appears in their library", async () => {
      const preview = (await reader(`/folder-links/${readToken}`)).data;
      assert.equal(preview.name, "Shared"); assert.equal(preview.role, null);
      assert.equal((await reader(`/folder-links/${readToken}/join`, "POST")).data.role, "read");
      assert.equal((await editor(`/folder-links/${editToken}/join`, "POST")).data.role, "edit");
      assert.equal((await reader(`/folder-links/${readToken}`)).data.role, "read");
      const library = (await reader("/library")).data;
      assert.deepEqual(library.folders.map((f: any) => [f.id, f.role, f.memberCount]), [[folder.id, "read", 0]]);
      assert.deepEqual(library.documents.map((d: any) => d.id), [doc.id]);
      assert.equal((await reader(`/documents/${doc.id}`)).data.content, "Original");
      assert.equal((await owner("/library")).data.folders.find((f: any) => f.id === folder.id).memberCount, 2);
    });

    await t.test("read access blocks every mutation and other folders", async () => {
      for (const [path, method, body] of [
        [`/documents/${doc.id}`, "PATCH", { content: "bad", version: 1 }],
        [`/documents/${doc.id}?version=1`, "DELETE", undefined],
        ["/documents", "POST", { title: "bad", content: "bad", folderId: folder.id }],
        [`/folders/${folder.id}`, "PATCH", { name: "bad" }],
        [`/folders/${folder.id}`, "DELETE", undefined],
        [`/folders/${folder.id}/links`, "POST", { access: "full", singleUse: false }],
        [`/folders/${folder.id}/members`, "GET", undefined],
      ] as const) assert.equal((await reader(path, method, body)).status, 403, `${method} ${path}`);
      assert.equal((await reader(`/documents/${doc.id}`, "PATCH", { content: "bad" })).status, 428);
      for (const path of [`/folders/${privateFolder.id}/links`, `/folders/${privateFolder.id}/members`]) {
        assert.equal((await reader(path)).status, 404);
      }
    });

    await t.test("edit access edits documents but cannot manage the folder or share it", async () => {
      const edited = await editor(`/documents/${doc.id}`, "PATCH", { content: "Edited", version: 1 });
      assert.equal(edited.status, 200); assert.equal(edited.data.version, 2); assert.equal(edited.data.role, "edit");
      const created = await editor("/documents", "POST", { title: "By editor", content: "Text", folderId: folder.id });
      assert.equal(created.status, 201);
      const stored = (await pool.query("SELECT owner_id FROM saved_items WHERE id=$1", [created.data.id])).rows[0];
      const ownerId = (await pool.query("SELECT owner_id FROM folders WHERE id=$1", [folder.id])).rows[0].owner_id;
      assert.equal(stored.owner_id, ownerId, "documents in a folder belong to the folder owner");
      assert.equal((await editor(`/folders/${folder.id}`, "PATCH", { name: "bad" })).status, 403);
      assert.equal((await editor(`/folders/${folder.id}`, "DELETE")).status, 403);
      assert.equal((await editor(`/folders/${folder.id}/links`, "POST", { access: "full", singleUse: false })).status, 403);
    });

    await t.test("moves stay inside one owner's library", async () => {
      const mine = (await editor("/folders", "POST", { name: "Editor own" })).data;
      const current = (await editor(`/documents/${doc.id}`)).data;
      const intoOther = await editor(`/documents/${doc.id}`, "PATCH", { folderId: mine.id, version: current.version });
      assert.equal(intoOther.status, 403);
      assert.equal((await editor(`/documents/${doc.id}`, "PATCH", { folderId: null, version: current.version })).status, 403);
      assert.equal((await editor(`/documents/${doc.id}`, "PATCH", { folderId: privateFolder.id, version: current.version })).status, 404);
      const moved = await owner(`/documents/${doc.id}`, "PATCH", { folderId: privateFolder.id, version: current.version });
      assert.equal(moved.status, 200);
      assert.equal((await editor(`/documents/${doc.id}`)).status, 404, "moving out of the shared folder ends shared access");
      const back = await owner(`/documents/${doc.id}`, "PATCH", { folderId: folder.id, version: moved.data.version });
      assert.equal(back.status, 200);
    });

    await t.test("two saves of the same version yield one success and one conflict", async () => {
      const { version } = (await owner(`/documents/${doc.id}`)).data;
      const responses = await Promise.all([
        owner(`/documents/${doc.id}`, "PATCH", { content: "Owner update", version }),
        editor(`/documents/${doc.id}`, "PATCH", { content: "Editor update", version }),
      ]);
      assert.deepEqual(responses.map(x => x.status).sort(), [200, 409]);
      const conflict = responses.find(x => x.status === 409)!;
      assert.equal(conflict.data.error.code, "VERSION_CONFLICT");
    });

    await t.test("a waiting shared write re-checks access after the row is moved away", async () => {
      const { version } = (await owner(`/documents/${doc.id}`)).data;
      const lock = await pool.connect();
      await lock.query("BEGIN");
      await lock.query("SELECT 1 FROM saved_items WHERE id=$1 FOR UPDATE", [doc.id]);
      const pending = editor(`/documents/${doc.id}`, "PATCH", { title: "Late edit", version });
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM saved_items WHERE id = $1 FOR UPDATE%'");
        if (waiting.rowCount) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!blocked) { await lock.query("ROLLBACK"); lock.release(); await pending; assert.fail("Shared request did not wait for the row lock"); }
      await lock.query("UPDATE saved_items SET folder_id=$1,version=version+1 WHERE id=$2", [privateFolder.id, doc.id]);
      await lock.query("COMMIT"); lock.release();
      assert.equal((await pending).status, 404);
      assert.equal((await pool.query("SELECT title FROM saved_items WHERE id=$1", [doc.id])).rows[0].title, "Original");
      await pool.query("UPDATE saved_items SET folder_id=$1 WHERE id=$2", [folder.id, doc.id]);
    });

    await t.test("concurrent transactions do not exhaust the connection pool", { timeout: 5000 }, async () => {
      const created = await Promise.all(Array.from({ length: 15 }, (_, i) => owner("/documents", "POST", { title: `Doc ${i}`, content: "x" })));
      const results = await Promise.all(created.map((c, i) => owner(`/documents/${c.data.id}`, "PATCH", { title: `Rename ${i}`, version: 1 })));
      assert.ok(results.every(result => result.status === 200));
    });

    await t.test("deleting requires the current version", async () => {
      const temp = (await owner("/documents", "POST", { title: "Temp", content: "x" })).data;
      assert.equal((await owner(`/documents/${temp.id}`, "DELETE")).status, 428);
      assert.equal((await owner(`/documents/${temp.id}?version=7`, "DELETE")).status, 409);
      assert.equal((await owner(`/documents/${temp.id}?version=1`, "DELETE")).status, 204);
    });

    await t.test("single-use link: preview does not consume, one visitor joins, retries resume", async () => {
      const raw = await link("read", true);
      assert.equal((await owner(`/folder-links/${raw}`)).data.role, "owner");
      assert.equal((await stranger(`/folder-links/${raw}`)).status, 200);
      const visitorA = client(), visitorB = client();
      await visitorA("/identity"); await visitorB("/identity");
      const results = await Promise.all([visitorA(`/folder-links/${raw}/join`, "POST"), visitorB(`/folder-links/${raw}/join`, "POST")]);
      assert.deepEqual(results.map(x => x.status).sort(), [200, 410]);
      const winner = results[0]!.status === 200 ? visitorA : visitorB;
      assert.equal((await winner(`/folder-links/${raw}/join`, "POST")).status, 200);
      assert.equal((await pool.query("SELECT use_count FROM folder_links WHERE token_hash=$1", [hash(raw)])).rows[0].use_count, 1);
      assert.equal((await stranger(`/folder-links/${raw}`)).data.error.code, "LINK_USED");
    });

    await t.test("a link with more access upgrades a membership, never downgrades", async () => {
      const full = await link("full");
      assert.equal((await reader(`/folder-links/${full}/join`, "POST")).data.role, "full");
      assert.equal((await reader(`/folder-links/${readToken}/join`, "POST")).data.role, "full");
      await pool.query("UPDATE folder_members SET access='read', link_hash=$1 WHERE member_id=(SELECT owner_id FROM sessions WHERE token_hash=$2)", [hash(readToken), hash(reader.cookies.get("pf_session")!)]);
    });

    await t.test("expired links stop new joins but existing members keep reopening them", async () => {
      await pool.query("UPDATE folder_links SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [hash(readToken)]);
      assert.equal((await stranger(`/folder-links/${readToken}/join`, "POST")).data.error.code, "LINK_EXPIRED");
      assert.equal((await reader(`/folder-links/${readToken}/join`, "POST")).status, 200);
      assert.equal((await reader(`/folder-links/${readToken}`)).data.role, "read");
      await pool.query("UPDATE folder_links SET expires_at=now()+interval '1 day' WHERE token_hash=$1", [hash(readToken)]);
    });

    await t.test("owner sees links and members, removes members, revokes links", async () => {
      const links = (await owner(`/folders/${folder.id}/links`)).data.links;
      assert.ok(links.some((l: any) => l.label === "Test link" && l.createdAt && l.expiresAt && l.lastUsedAt && l.id === hash(editToken)));
      const members = (await owner(`/folders/${folder.id}/members`)).data.members;
      assert.ok(members.length >= 2 && members.every((m: any) => m.registered === false && m.linkLabel === "Test link"));
      const editorId = (await pool.query("SELECT owner_id FROM sessions WHERE token_hash=$1", [hash(editor.cookies.get("pf_session")!)])).rows[0].owner_id;
      assert.equal((await owner(`/folders/${folder.id}/members/${editorId}`, "DELETE")).status, 204);
      assert.equal((await editor(`/documents/${doc.id}`)).status, 404);
      assert.equal((await editor(`/folder-links/${editToken}/join`, "POST")).status, 200, "a valid link can be used again");
      assert.equal((await owner(`/folders/${folder.id}/links/${hash(editToken)}`, "DELETE")).status, 204);
      assert.equal((await editor(`/documents/${doc.id}`)).status, 404, "revoking a link removes those who joined through it");
      assert.equal((await editor(`/folder-links/${editToken}/join`, "POST")).data.error.code, "LINK_UNAVAILABLE");
    });

    await t.test("members can leave; owners cannot", async () => {
      const leaver = client(); await leaver("/identity");
      await leaver(`/folder-links/${readToken}/join`, "POST");
      assert.equal((await leaver(`/folders/${folder.id}/membership`, "DELETE")).status, 204);
      assert.equal((await leaver("/library")).data.folders.length, 0);
      assert.equal((await owner(`/folders/${folder.id}/membership`, "DELETE")).status, 400);
    });

    await t.test("guest library and memberships move to the account on passkey login", async () => {
      const guest = client(); await guest("/identity");
      const guestDoc = (await guest("/documents", "POST", { title: "Guest", content: "Guest text" })).data;
      await guest(`/folder-links/${readToken}/join`, "POST");
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
      const library = (await guest("/library")).data;
      assert.ok(library.documents.some((d: any) => d.id === guestDoc.id));
      assert.deepEqual(library.folders.map((f: any) => [f.id, f.role]), [[folder.id, "read"]]);
      await guest("/auth/logout", "POST");
      assert.equal((await guest(`/documents/${doc.id}`)).status, 404, "a new guest session has no access");
    });

    await t.test("managers can delete a folder keeping or deleting its documents", async () => {
      const managed = (await owner("/folders", "POST", { name: "Managed" })).data;
      const raw = await link("full", false, managed.id);
      const manager = client(); await manager("/identity");
      await manager(`/folder-links/${raw}/join`, "POST");
      const kept = (await manager("/documents", "POST", { title: "Kept", content: "Text", folderId: managed.id })).data;
      assert.equal((await manager(`/folders/${managed.id}`, "PATCH", { name: "Renamed" })).data.name, "Renamed");
      assert.equal((await manager(`/folders/${managed.id}`, "DELETE")).status, 204);
      assert.equal((await pool.query("SELECT folder_id FROM saved_items WHERE id=$1", [kept.id])).rows[0].folder_id, null);
      const doomed = (await owner("/folders", "POST", { name: "Doomed" })).data;
      const inside = (await owner("/documents", "POST", { title: "Gone", content: "Text", folderId: doomed.id })).data;
      assert.equal((await owner(`/folders/${doomed.id}?documents=delete`, "DELETE")).status, 204);
      assert.equal((await pool.query("SELECT 1 FROM saved_items WHERE id=$1", [inside.id])).rowCount, 0);
    });

    await t.test("cleanup removes expired sessions and rate records, keeping memberships", async () => {
      await pool.query("UPDATE library_rate_limits SET window_start=now()-interval '2 hours'");
      await pool.query("UPDATE folder_links SET expires_at=now()-interval '31 days' WHERE token_hash=$1", [hash(readToken)]);
      await service.cleanup();
      assert.equal((await pool.query("SELECT 1 FROM library_rate_limits")).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM folder_links WHERE token_hash=$1", [hash(readToken)])).rowCount, 0);
      assert.equal((await reader(`/documents/${doc.id}`)).status, 200);
      assert.equal((await owner(`/folders/${folder.id}/members`)).data.members.find((m: any) => m.access === "read").linkLabel, null);
    });

    await t.test("link creation rate and per-folder quota are enforced", async () => {
      const who = (await pool.query("SELECT owner_id FROM folders WHERE id=$1", [privateFolder.id])).rows[0].owner_id;
      await pool.query("INSERT INTO library_rate_limits VALUES($1,date_trunc('minute',now()),20) ON CONFLICT (key) DO UPDATE SET count=20, window_start=date_trunc('minute',now())", [`create:${who}`]);
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

test("legacy session grants become memberships on migration", async () => {
  const admin = new Pool({ connectionString });
  const schema = `legacy_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    await migrate(pool);
    const owner = randomUUID(), visitor = randomUUID(), folder = randomUUID();
    await pool.query("INSERT INTO owners(id) VALUES($1),($2)", [owner, visitor]);
    await pool.query("INSERT INTO sessions VALUES('s',$1,now()+interval '1 day')", [visitor]);
    await pool.query("INSERT INTO folders(id,owner_id,name) VALUES($1,$2,'F')", [folder, owner]);
    await pool.query("INSERT INTO folder_links(token_hash,folder_id,access) VALUES('l',$1,'edit')", [folder]);
    await pool.query(`CREATE TABLE folder_grants(token_hash TEXT PRIMARY KEY, link_hash TEXT, folder_id UUID, access TEXT, expires_at TIMESTAMPTZ, session_hash TEXT)`);
    await pool.query("INSERT INTO folder_grants VALUES('g','l',$1,'edit',now()+interval '1 hour','s')", [folder]);
    await migrate(pool);
    const members = (await pool.query("SELECT member_id, access, link_hash FROM folder_members")).rows;
    assert.deepEqual(members, [{ member_id: visitor, access: "edit", link_hash: "l" }]);
    assert.equal((await pool.query("SELECT to_regclass('folder_grants') AS t")).rows[0].t, null);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
