import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate";
import { createAuthRouter, expectedOrigin, type AuthRouter } from "../src/auth";
import { PgShareRepository } from "../src/repositories/shareRepository";
import { ShareService } from "../src/services/shareService";
import { ShareHandler } from "../src/handlers/shareHandler";
import { createApiRouter } from "../src/routes";
import { PgReportRepository } from "../src/repositories/reportRepository";
import { ReportService } from "../src/services/reportService";
import { ReportHandler } from "../src/handlers/reportHandler";
import { errorHandler } from "../src/middleware/errorHandler";
import { PgLibraryRepository } from "../src/repositories/libraryRepository";
import { LibraryService } from "../src/services/libraryService";
import { createLibraryRouter } from "../src/handlers/libraryHandler";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database");

test("share links: ownership, views, expiry, delete and link previews", async t => {
  const admin = new Pool({ connectionString });
  const schema = `audit_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const publicDir = await mkdtemp(path.join(tmpdir(), "pf-"));
  const indexFile = path.join(publicDir, "index.html");
  await writeFile(indexFile, "<html><head><title>پرشین فرمتر</title></head><body></body></html>");
  const auth = createAuthRouter(pool) as AuthRouter;
  const repository = new PgShareRepository(pool);
  const service = new ShareService(repository, 200000);
  const shares = new ShareHandler(service, auth.principal, indexFile, expectedOrigin);
  const app = express(); app.use(express.json());
  app.use("/api", createApiRouter(shares, new ReportHandler(new ReportService(new PgReportRepository(pool), repository), "")));
  app.use("/api", auth);
  app.use("/api", createLibraryRouter(new LibraryService(new PgLibraryRepository(pool), 200000), auth));
  app.get("/s/:id", shares.page);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const root = `http://127.0.0.1:${(server.address() as any).port}`;
  function client() {
    const cookies = new Map<string, string>();
    return async (url: string, method = "GET", body?: unknown) => {
      const headers: Record<string, string> = { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(root + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const raw of res.headers.getSetCookie()) {
        const pair = raw.split(";")[0]!; const at = pair.indexOf("=");
        cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
      const text = await res.text();
      let data: any = text; try { data = JSON.parse(text); } catch (_) { /* HTML page */ }
      return { status: res.status, data };
    };
  }
  try {
    await migrate(pool); await migrate(pool); // Migration must be safe on restart.
    const owner = client(), viewer = client();
    const created = await owner("/api/shares", "POST", { content: "# گزارش \"ماهانه\" <b>\n\nخلاصهٔ کار این ماه." });
    assert.equal(created.status, 201);
    const id = created.data.id as string;

    await t.test("only the owner sees the link, with views by others counted", async () => {
      assert.equal((await owner(`/api/shares/${id}`)).status, 200); // the owner's own view
      assert.equal((await viewer(`/api/shares/${id}`)).status, 200);
      assert.equal((await viewer(`/api/shares/${id}`)).status, 200);
      const mine = (await owner("/api/shares")).data.shares;
      assert.deepEqual(mine.map((s: any) => [s.id, s.title, s.viewCount, s.expiresAt]), [[id, "گزارش \"ماهانه\"", 2, null]]);
      assert.deepEqual((await viewer("/api/shares")).data.shares, []);
    });

    await t.test("the page carries escaped link-preview tags and does not count a view", async () => {
      const page = (await viewer(`/s/${id}`)).data as string;
      assert.match(page, /<meta property="og:title" content="گزارش &quot;ماهانه&quot;" \/>/);
      assert.match(page, /<meta property="og:description" content="خلاصهٔ کار این ماه." \/>/);
      assert.match(page, new RegExp(`og:url" content="${root}/s/${id}"`));
      assert.doesNotMatch(page, /<b>/);
      assert.equal((await owner("/api/shares")).data.shares[0].viewCount, 2);
      const missing = (await viewer("/s/nothing")).data as string;
      assert.match(missing, /<title>پرشین فرمتر<\/title>/);
      assert.doesNotMatch(missing, /og:title/);
    });

    await t.test("expiry: only the owner sets it, and an expired link reads as missing", async () => {
      assert.equal((await viewer(`/api/shares/${id}`, "PATCH", { expiresInDays: 1 })).status, 404);
      assert.equal((await owner(`/api/shares/${id}`, "PATCH", { expiresInDays: 3 })).status, 400);
      const set = await owner(`/api/shares/${id}`, "PATCH", { expiresInDays: 7 });
      assert.equal(set.status, 200);
      assert.ok(new Date(set.data.expiresAt).getTime() > Date.now() + 6 * 86_400_000);
      await pool.query("UPDATE shares SET expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
      assert.equal((await viewer(`/api/shares/${id}`)).status, 404);
      assert.doesNotMatch((await viewer(`/s/${id}`)).data, /og:title/);
      assert.equal((await owner(`/api/shares/${id}`, "PATCH", { expiresInDays: null })).data.expiresAt, null);
      assert.equal((await viewer(`/api/shares/${id}`)).status, 200);
    });

    await t.test("a live link follows the saved document; otherwise it keeps the snapshot", async () => {
      const doc = (await owner("/api/documents", "POST", { title: "پیش‌نویس", content: "# نسخهٔ اول\n\nغلط املائی" })).data;
      const linked = (await owner("/api/shares", "POST", { content: "# نسخهٔ اول\n\nغلط املائی", documentId: doc.id })).data.id;
      const plain = (await owner("/api/shares", "POST", { content: "متن آزاد" })).data.id;
      const foreign = (await viewer("/api/shares", "POST", { content: "دزدکی", documentId: doc.id })).data.id;
      const rows = (await owner("/api/shares")).data.shares;
      assert.deepEqual(rows.filter((s: any) => [linked, plain].includes(s.id)).map((s: any) => [s.id, s.linked, s.live]), [[plain, false, false], [linked, true, false]]);
      assert.equal((await viewer("/api/shares")).data.shares.find((s: any) => s.id === foreign).linked, false); // can't read the document

      const updated = await owner(`/api/documents/${doc.id}`, "PATCH", { content: "# نسخهٔ دوم\n\nاصلاح‌شده", version: doc.version });
      assert.equal(updated.status, 200);
      assert.match((await viewer(`/api/shares/${linked}`)).data.content, /نسخهٔ اول/); // snapshot until made live
      assert.equal((await owner(`/api/shares/${plain}`, "PATCH", { live: true })).status, 400);
      assert.equal((await viewer(`/api/shares/${linked}`, "PATCH", { live: true })).status, 404);
      const live = await owner(`/api/shares/${linked}`, "PATCH", { live: true });
      assert.deepEqual([live.status, live.data.live, live.data.title], [200, true, "نسخهٔ دوم"]);
      assert.match((await viewer(`/api/shares/${linked}`)).data.content, /اصلاح‌شده/);
      assert.match((await viewer(`/s/${linked}`)).data, /og:title" content="نسخهٔ دوم"/);

      await owner(`/api/documents/${doc.id}?version=${updated.data.version}`, "DELETE"); // to the trash
      assert.match((await viewer(`/api/shares/${linked}`)).data.content, /نسخهٔ اول/);
      await owner(`/api/documents/${doc.id}/restore`, "POST");
      assert.match((await viewer(`/api/shares/${linked}`)).data.content, /اصلاح‌شده/);
      await owner(`/api/shares/${linked}`, "PATCH", { live: false });
      assert.match((await viewer(`/api/shares/${linked}`)).data.content, /نسخهٔ اول/);
    });

    await t.test("only the owner can delete, and a deleted link is gone", async () => {
      assert.equal((await viewer(`/api/shares/${id}`, "DELETE")).status, 404);
      assert.equal((await owner(`/api/shares/${id}`, "DELETE")).status, 204);
      assert.equal((await viewer(`/api/shares/${id}`)).status, 404);
      assert.ok(!(await owner("/api/shares")).data.shares.some((s: any) => s.id === id));
    });
  } finally {
    server.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
