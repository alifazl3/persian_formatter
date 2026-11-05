import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate";
import { createAuthRouter, type AuthRouter } from "../src/auth";
import { PgLibraryRepository } from "../src/repositories/libraryRepository";
import { LibraryService } from "../src/services/libraryService";
import { createLibraryRouter } from "../src/handlers/libraryHandler";
import { PgShareRepository } from "../src/repositories/shareRepository";
import { ShareService } from "../src/services/shareService";
import { ShareHandler } from "../src/handlers/shareHandler";
import { PgReportRepository } from "../src/repositories/reportRepository";
import { ReportService } from "../src/services/reportService";
import { ReportHandler } from "../src/handlers/reportHandler";
import { createApiRouter } from "../src/routes";
import { PgAdminRepository } from "../src/repositories/adminRepository";
import { AdminService } from "../src/services/adminService";
import { createAdminRouter } from "../src/handlers/adminHandler";
import { errorHandler } from "../src/middleware/errorHandler";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ADMIN = "boss@example.com";

test("admin dashboard: access, numbers, lists and actions", async t => {
  const admin = new Pool({ connectionString });
  const schema = `audit_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const auth = createAuthRouter(pool, [ADMIN]) as AuthRouter;
  const shareRepository = new PgShareRepository(pool);
  const shares = new ShareHandler(new ShareService(shareRepository, 200000), auth.principal, "", () => "");
  const app = express(); app.use(express.json());
  app.use("/api", createApiRouter(shares, new ReportHandler(new ReportService(new PgReportRepository(pool), shareRepository), "")));
  app.use("/api", auth);
  app.use("/api", createLibraryRouter(new LibraryService(new PgLibraryRepository(pool), 200000), auth));
  app.use("/api/admin", createAdminRouter(new AdminService(new PgAdminRepository(pool), [ADMIN]), auth.principal));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  function client(cookie = "") {
    let jar = cookie;
    return async (path: string, method = "GET", body?: unknown) => {
      const headers: Record<string, string> = { cookie: jar };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = res.headers.getSetCookie()[0];
      if (set && !jar) jar = set.split(";")[0]!;
      return { status: res.status, data: await res.json().catch(() => null) as any };
    };
  }
  /** A signed-in account (passkey registration is covered by the auth tests). */
  async function account(email: string) {
    const id = randomUUID(), token = randomUUID();
    await pool.query("INSERT INTO owners(id, email) VALUES($1, $2)", [id, email]);
    await pool.query("INSERT INTO webauthn_credentials(id, owner_id, public_key) VALUES($1, $2, '{}')", [randomUUID(), id]);
    await pool.query("INSERT INTO sessions(token_hash, owner_id, expires_at) VALUES($1, $2, now() + interval '1 day')", [hash(token), id]);
    return { id, call: client(`pf_session=${token}`) };
  }
  try {
    await migrate(pool); await migrate(pool);
    const boss = await account(ADMIN), user = await account("writer@example.com");
    const guest = client(), idle = client();
    assert.equal((await guest("/identity")).status, 200);
    assert.equal((await idle("/identity")).status, 200); // a visitor who keeps nothing

    await user.call("/documents", "POST", { title: "یک", content: "متن یک" });
    await user.call("/documents", "POST", { title: "دو", content: "متن دو" });
    await guest("/documents", "POST", { title: "مهمان", content: "متن مهمان" });
    const popular = (await user.call("/shares", "POST", { content: "# راهنمای پرطرفدار\n\nمتن" })).data.id;
    const reported = (await guest("/shares", "POST", { content: "# متن مشکل‌دار\n\nاطلاعات شخصی" })).data.id;
    for (let i = 0; i < 3; i++) await idle(`/shares/${popular}`);
    await idle(`/shares/${reported}/reports`, "POST", { note: "اطلاعات شخصی دارد" });

    await t.test("only admin emails see the flag and reach the API", async () => {
      assert.equal((await boss.call("/identity")).data.admin, true);
      assert.equal((await user.call("/identity")).data.admin, false);
      assert.equal((await guest("/identity")).data.admin, false);
      for (const who of [user.call, guest, client()]) {
        assert.equal((await who("/admin/overview")).status, 404);
        assert.equal((await who(`/admin/shares/${popular}`, "DELETE")).status, 404);
      }
      assert.equal((await user.call(`/shares/${popular}`)).status, 200); // still there
    });

    await t.test("overview counts accounts, guests, texts, links, views and open reports", async () => {
      const { data } = await boss.call("/admin/overview?days=7");
      assert.equal(data.days, 7);
      assert.deepEqual(
        [data.totals.accounts, data.totals.newAccounts, data.totals.documents, data.totals.shares, data.totals.views, data.totals.openReports],
        [2, 2, 3, 2, 3, 1]
      );
      assert.ok(data.totals.activeGuests >= 2);
      assert.equal(data.daily.length, 7);
      const today = data.daily.at(-1);
      assert.deepEqual([today.documents, today.shares, today.accounts], [3, 2, 2]);
      assert.equal(data.topShares[0].title, "راهنمای پرطرفدار");
      assert.equal(data.topShares[0].viewCount, 3);
      assert.equal((await boss.call("/admin/overview?days=999")).data.days, 30);
    });

    await t.test("users: accounts by default; guests only once they keep something", async () => {
      const accounts = (await boss.call("/admin/users")).data;
      assert.deepEqual(accounts.counts, { all: 3, account: 2, guest: 1 });
      assert.deepEqual(accounts.users.map((u: any) => u.email).sort(), [ADMIN, "writer@example.com"]);
      const writer = accounts.users.find((u: any) => u.email === "writer@example.com");
      assert.deepEqual([writer.documents, writer.shares, writer.views], [2, 1, 3]);
      const guests = (await boss.call("/admin/users?kind=guest")).data.users;
      assert.deepEqual(guests.map((u: any) => [u.email, u.documents, u.shares]), [[null, 1, 1]]);
      assert.equal((await boss.call("/admin/users?kind=all&q=writer")).data.users.length, 1);
    });

    await t.test("shares: filters, owner filter and search", async () => {
      const all = (await boss.call("/admin/shares?sort=views")).data;
      assert.deepEqual(all.counts, { all: 2, live: 0, expiring: 0, expired: 0, reported: 1 });
      assert.deepEqual(all.shares.map((s: any) => s.title), ["راهنمای پرطرفدار", "متن مشکل‌دار"]);
      assert.equal(all.shares[0].ownerEmail, "writer@example.com");
      assert.deepEqual((await boss.call("/admin/shares?status=reported")).data.shares.map((s: any) => [s.id, s.openReports]), [[reported, 1]]);
      assert.deepEqual((await boss.call(`/admin/shares?owner=${user.id}`)).data.shares.map((s: any) => s.id), [popular]);
      assert.deepEqual((await boss.call("/admin/shares?q=شخصی")).data.shares.map((s: any) => s.id), [reported]);
    });

    await t.test("reports can be resolved, and a link deleted", async () => {
      const open = (await boss.call("/admin/reports")).data.reports;
      assert.deepEqual(open.map((r: any) => [r.shareId, r.title, r.note]), [[reported, "متن مشکل‌دار", "اطلاعات شخصی دارد"]]);
      assert.equal((await boss.call(`/admin/reports/${open[0].id}/resolve`, "POST")).status, 204);
      assert.equal((await boss.call(`/admin/reports/${open[0].id}/resolve`, "POST")).status, 404);
      assert.deepEqual((await boss.call("/admin/reports")).data.reports, []);
      assert.equal((await boss.call("/admin/reports?status=all")).data.reports.length, 1);
      assert.equal((await boss.call(`/admin/shares/${reported}`, "DELETE")).status, 204);
      assert.equal((await idle(`/shares/${reported}`)).status, 404);
      assert.equal((await boss.call("/admin/overview")).data.totals.openReports, 0);
    });
  } finally {
    server.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
