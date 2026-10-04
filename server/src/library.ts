import { Router, Request, Response, NextFunction } from "express";
import { Pool, PoolClient } from "pg";
import { randomUUID } from "crypto";
import { AuthRouter, cookie, hash, token } from "./auth";
import { AppError, NotFoundError, ValidationError } from "./errors";

const uuid = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new ValidationError("Invalid id");
  return value;
};
const name = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) throw new ValidationError("Name must be 1–100 characters");
  return value.trim();
};
const content = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ValidationError(`Content must be 1–${max} characters`);
  return value;
};
const title = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) throw new ValidationError("Title must be 1–200 characters");
  return value.trim();
};
const forbidden = () => new AppError(403, "FORBIDDEN", "برای این کار به پوشه دسترسی ندارید.");
type Access = "read" | "edit" | "full";
type Grant = { folder_id: string; access: Access; expires_at?: Date };
const itemColumns = "id,folder_id,title,content,created_at,updated_at,version";
const conflict = () => new AppError(409, "VERSION_CONFLICT", "این متن تغییر کرده است. نسخهٔ تازه را باز کنید یا نوشتهٔ خود را جداگانه ذخیره کنید.");
const linkError = (code: string, message: string) => new AppError(410, code, message);
const sessionHash = (req: Request) => { const value = cookie(req, "pf_session"); return value ? hash(value) : null; };

export async function cleanupLibrary(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM folder_grants WHERE expires_at<=now()");
  await pool.query("DELETE FROM sessions WHERE expires_at<=now()");
  await pool.query("DELETE FROM webauthn_challenges WHERE expires_at<=now()");
  await pool.query("DELETE FROM library_rate_limits WHERE window_start<now()-interval '1 hour'");
  await pool.query("DELETE FROM folder_links WHERE expires_at<now()-interval '30 days'");
}

export function createLibraryRouter(pool: Pool, auth: AuthRouter, maxContentLength: number): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const wrap = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { handler(req, res).catch(next); };
  async function owner(req: Request, res: Response): Promise<string> { return (await auth.principal(req, res))!.id; }
  const principals = new WeakMap<Request, ReturnType<AuthRouter["principal"]>>();
  function principal(req: Request, res: Response) {
    let result = principals.get(req);
    if (!result) { result = auth.principal(req, res, false); principals.set(req, result); }
    return result;
  }
  async function transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await pool.connect();
    try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
    catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
  }
  async function limit(key: string, maximum: number): Promise<void> {
    const result = await pool.query(`INSERT INTO library_rate_limits(key,window_start,count)
      VALUES($1,date_trunc('minute',now()),1) ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN library_rate_limits.window_start=date_trunc('minute',now()) THEN library_rate_limits.count+1 ELSE 1 END,
      window_start=date_trunc('minute',now()) RETURNING count`, [key]);
    if (result.rows[0].count > maximum) throw new AppError(429, "RATE_LIMIT", "درخواست‌ها زیاد است؛ یک دقیقه بعد دوباره تلاش کنید.");
  }
  async function grant(req: Request, db: Pool | PoolClient = pool): Promise<Grant | null> {
    const raw = req.get("X-Folder-Grant");
    const link = req.get("X-Folder-Link");
    if (!raw && !link) return null;
    const result = await db.query<Grant>(`SELECT g.folder_id,g.access,g.expires_at FROM folder_grants g
      JOIN folder_links l ON l.token_hash=g.link_hash
      WHERE g.expires_at>now() AND (l.expires_at IS NULL OR l.expires_at>now())
      AND (g.session_hash IS NULL OR EXISTS(SELECT 1 FROM sessions s WHERE s.token_hash=g.session_hash AND s.expires_at>now())) AND (
        ($1::text IS NOT NULL AND g.token_hash=$1 AND (g.session_hash IS NULL OR g.session_hash=$3)) OR
        ($2::text IS NOT NULL AND g.link_hash=$2 AND g.session_hash=$3)
      ) LIMIT 1`, [raw ? hash(raw) : null, link ? hash(link) : null, sessionHash(req)]);
    return result.rows[0] ?? null;
  }
  async function accessTo(req: Request, res: Response, folderId: string, db: Pool | PoolClient = pool): Promise<Access> {
    const who = await principal(req, res);
    if (who && (await db.query("SELECT 1 FROM folders WHERE id=$1 AND owner_id=$2", [folderId, who.id])).rows.length) return "full";
    const access = await grant(req, db);
    if (access?.folder_id === folderId) return access.access;
    throw forbidden();
  }
  async function canWrite(req: Request, res: Response, folderId: string, db: Pool | PoolClient = pool, manage = false): Promise<void> {
    const access = await accessTo(req, res, folderId, db);
    if (access === "read" || (manage && access !== "full")) throw forbidden();
  }
  router.get("/library", wrap(async (req, res) => {
    const id = await owner(req, res);
    const [folders, items] = await Promise.all([
      pool.query("SELECT id,name,created_at FROM folders WHERE owner_id=$1 ORDER BY created_at DESC", [id]),
      pool.query("SELECT id,folder_id,title,content,created_at,updated_at,version FROM saved_items WHERE owner_id=$1 ORDER BY updated_at DESC", [id])
    ]);
    res.json({ folders: folders.rows, items: items.rows });
  }));
  router.post("/folders", wrap(async (req, res) => {
    const id = randomUUID(); const who = await owner(req, res);
    const result = await pool.query("INSERT INTO folders(id,owner_id,name) VALUES($1,$2,$3) RETURNING id,name,created_at", [id, who, name(req.body?.name)]);
    res.status(201).json(result.rows[0]);
  }));
  router.patch("/folders/:id", wrap(async (req, res) => {
    const id = uuid(req.params.id); await canWrite(req, res, id, pool, true);
    const result = await pool.query("UPDATE folders SET name=$1 WHERE id=$2 RETURNING id,name,created_at", [name(req.body?.name), id]);
    if (!result.rows[0]) throw new NotFoundError(); res.json(result.rows[0]);
  }));
  router.delete("/folders/:id", wrap(async (req, res) => {
    const id = uuid(req.params.id); await canWrite(req, res, id, pool, true);
    await pool.query("DELETE FROM folders WHERE id=$1", [id]); res.status(204).end();
  }));
  router.post("/items", wrap(async (req, res) => {
    const text = content(req.body?.content, maxContentLength);
    const itemTitle = title(req.body?.title);
    const folderId = req.body?.folderId == null ? null : uuid(req.body.folderId);
    if (folderId) await canWrite(req, res, folderId);
    const access = await grant(req);
    if (!folderId && access) throw forbidden();
    const who = folderId ? await pool.query<{ owner_id: string }>("SELECT owner_id FROM folders WHERE id=$1", [folderId]) : null;
    const ownerId = who?.rows[0]?.owner_id ?? await owner(req, res);
    const result = await pool.query("INSERT INTO saved_items(id,owner_id,folder_id,title,content) VALUES($1,$2,$3,$4,$5) RETURNING id,folder_id,title,content,created_at,updated_at,version", [randomUUID(), ownerId, folderId, itemTitle, text]);
    res.status(201).json(result.rows[0]);
  }));
  router.patch("/items/:id", wrap(async (req, res) => {
    const id = uuid(req.params.id);
    const who = await principal(req, res);
    const updated = await transaction(async db => {
      const existing = await db.query("SELECT owner_id,folder_id,version FROM saved_items WHERE id=$1 FOR UPDATE", [id]);
      const item = existing.rows[0]; if (!item) throw new NotFoundError();
      const isOwner = who?.id === item.owner_id;
      if (!isOwner) { if (!item.folder_id) throw forbidden(); await canWrite(req, res, item.folder_id, db); }
      const expected = req.body?.version;
      if (expected === undefined && req.body?.content !== undefined) throw new AppError(428, "VERSION_REQUIRED", "پیش از ذخیره، نسخهٔ تازهٔ متن را باز کنید.");
      if (expected !== undefined && (!Number.isSafeInteger(expected) || expected !== item.version)) throw conflict();
      const fields: string[] = []; const values: unknown[] = [id];
      const set = (field: string, value: unknown) => { values.push(value); fields.push(`${field}=$${values.length}`); };
      if (req.body?.title !== undefined) set("title", title(req.body.title));
      if (req.body?.content !== undefined) set("content", content(req.body.content, maxContentLength));
      if (req.body?.folderId !== undefined) {
        const folderId = req.body.folderId === null ? null : uuid(req.body.folderId);
        if (folderId !== item.folder_id && (!isOwner || (folderId && !(await db.query("SELECT 1 FROM folders WHERE id=$1 AND owner_id=$2", [folderId, item.owner_id])).rows.length))) throw forbidden();
        set("folder_id", folderId);
      }
      if (!fields.length) throw new ValidationError("No changes supplied");
      const result = await db.query(`UPDATE saved_items SET ${fields.join(",")},version=version+1,updated_at=now() WHERE id=$1 RETURNING ${itemColumns}`, values);
      return result.rows[0];
    });
    res.json(updated);
  }));
  router.delete("/items/:id", wrap(async (req, res) => {
    const id = uuid(req.params.id);
    const who = await principal(req, res);
    await transaction(async db => {
      const result = await db.query("SELECT owner_id,folder_id,version FROM saved_items WHERE id=$1 FOR UPDATE", [id]);
      const item = result.rows[0]; if (!item) throw new NotFoundError();
      if (who?.id !== item.owner_id) { if (!item.folder_id) throw forbidden(); await canWrite(req, res, item.folder_id, db); }
      if (req.body?.version !== undefined && req.body.version !== item.version) throw conflict();
      await db.query("DELETE FROM saved_items WHERE id=$1", [id]);
    });
    res.status(204).end();
  }));
  router.get("/folders/:id", wrap(async (req, res) => {
    const id = uuid(req.params.id); const access = await accessTo(req, res, id);
    const [folder, items] = await Promise.all([
      pool.query("SELECT id,name,created_at FROM folders WHERE id=$1", [id]),
      pool.query("SELECT id,folder_id,title,content,created_at,updated_at,version FROM saved_items WHERE folder_id=$1 ORDER BY updated_at DESC", [id])
    ]);
    if (!folder.rows[0]) throw new NotFoundError();
    res.json({ folder: folder.rows[0], items: items.rows, access });
  }));
  router.post("/folders/:id/links", wrap(async (req, res) => {
    const id = uuid(req.params.id); const who = await owner(req, res);
    const access = req.body?.access; const singleUse = req.body?.singleUse;
    if (!["read", "edit", "full"].includes(access)) throw new ValidationError("Invalid access");
    if (typeof singleUse !== "boolean") throw new ValidationError("Invalid use limit");
    const days = req.body?.expiresInDays ?? 7;
    if (![1, 7, 30].includes(days)) throw new ValidationError("Invalid expiry");
    const label = req.body?.label ? name(req.body.label) : "";
    await limit(`create:${who}`, 20);
    const value = token();
    const link = await transaction(async db => {
      const owned = await db.query("SELECT 1 FROM folders WHERE id=$1 AND owner_id=$2 FOR UPDATE", [id, who]);
      if (!owned.rows.length) throw forbidden();
      const count = await db.query("SELECT count(*) FROM folder_links WHERE folder_id=$1 AND (expires_at IS NULL OR expires_at>now())", [id]);
      if (Number(count.rows[0].count) >= 50) throw new AppError(409, "LINK_LIMIT", "هر پوشه تا ۵۰ لینک فعال دارد؛ ابتدا لینک‌های اضافی را لغو کنید.");
      return (await db.query(`INSERT INTO folder_links(token_hash,folder_id,access,max_uses,label,expires_at)
        VALUES($1,$2,$3,$4,$5,now()+($6*interval '1 day')) RETURNING expires_at`, [hash(value), id, access, singleUse ? 1 : null, label, days])).rows[0];
    });
    res.status(201).json({ token: value, access, singleUse, expiresAt: link.expires_at });
  }));
  router.get("/folders/:id/links", wrap(async (req, res) => {
    const id = uuid(req.params.id); const who = await owner(req, res);
    if (!(await pool.query("SELECT 1 FROM folders WHERE id=$1 AND owner_id=$2", [id, who])).rows.length) throw forbidden();
    const links = await pool.query("SELECT token_hash,access,max_uses,use_count,created_at,label,expires_at,last_used_at FROM folder_links WHERE folder_id=$1 ORDER BY created_at DESC", [id]);
    res.json({ links: links.rows });
  }));
  router.delete("/folders/:id/links/:hash", wrap(async (req, res) => {
    const id = uuid(req.params.id); const who = await owner(req, res);
    if (!/^[0-9a-f]{64}$/.test(req.params.hash ?? "")) throw new ValidationError("Invalid link id");
    const result = await pool.query("DELETE FROM folder_links l USING folders f WHERE l.token_hash=$1 AND l.folder_id=$2 AND f.id=l.folder_id AND f.owner_id=$3", [req.params.hash, id, who]);
    if (!result.rowCount) throw new NotFoundError(); res.status(204).end();
  }));
  router.get("/folder-links/:token", wrap(async (req, res) => {
    const raw = req.params.token ?? "";
    if (!/^[A-Za-z0-9_-]{30,100}$/.test(raw)) throw new NotFoundError();
    const who = await auth.principal(req, res, false);
    const found = await pool.query(`SELECT l.*,f.name,f.owner_id,
      EXISTS(SELECT 1 FROM folder_grants g WHERE g.link_hash=l.token_hash AND g.session_hash=$2 AND g.expires_at>now()) AS resumed
      FROM folder_links l JOIN folders f ON f.id=l.folder_id WHERE l.token_hash=$1`, [hash(raw), sessionHash(req)]);
    const link = found.rows[0]; if (!link) throw linkError("LINK_UNAVAILABLE", "این لینک لغو شده یا وجود ندارد.");
    if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) throw linkError("LINK_EXPIRED", "زمان این لینک به پایان رسیده است؛ از مالک لینک تازه بگیرید.");
    const isOwner = who?.id === link.owner_id;
    if (!isOwner && !link.resumed && link.max_uses !== null && link.use_count >= link.max_uses) throw linkError("LINK_USED", "این لینک یک‌بارمصرف قبلاً استفاده شده است؛ از مالک لینک تازه بگیرید.");
    res.json({ name: link.name, folderId: link.folder_id, access: isOwner ? "full" : link.access, owner: isOwner,
      resumed: link.resumed, singleUse: link.max_uses === 1, expiresAt: link.expires_at });
  }));
  router.post("/folder-links/:token/redeem", wrap(async (req, res) => {
    const raw = req.params.token ?? "";
    if (!/^[A-Za-z0-9_-]{30,100}$/.test(raw)) throw new NotFoundError();
    // A stable cookie is required before consuming a single-use link. A lost
    // response can then be retried safely from the same browser session.
    const who = await auth.principal(req, res, false);
    const session = sessionHash(req);
    if (!who || !session) throw new AppError(401, "SESSION_REQUIRED", "ابتدا صفحه را دوباره باز کنید.");
    await limit(`redeem-session:${session}`, 60);
    await limit(`redeem-link:${hash(raw)}`, 120);
    const value = token();
    const result = await transaction(async db => {
      const found = await db.query("SELECT * FROM folder_links WHERE token_hash=$1 FOR UPDATE", [hash(raw)]);
      const link = found.rows[0]; if (!link) throw linkError("LINK_UNAVAILABLE", "این لینک لغو شده یا وجود ندارد.");
      if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) throw linkError("LINK_EXPIRED", "زمان این لینک به پایان رسیده است؛ از مالک لینک تازه بگیرید.");
      const existing = await db.query("SELECT expires_at FROM folder_grants WHERE link_hash=$1 AND session_hash=$2 AND expires_at>now()", [hash(raw), session]);
      let expiresAt = existing.rows[0]?.expires_at;
      if (!expiresAt) {
        if (link.max_uses !== null && link.use_count >= link.max_uses) throw linkError("LINK_USED", "این لینک یک‌بارمصرف قبلاً استفاده شده است؛ از مالک لینک تازه بگیرید.");
        expiresAt = new Date(Math.min(Date.now() + 86400000, link.expires_at ? new Date(link.expires_at).getTime() : Infinity));
        await db.query("UPDATE folder_links SET use_count=use_count+1 WHERE token_hash=$1", [hash(raw)]);
      }
      await db.query("UPDATE folder_links SET last_used_at=now() WHERE token_hash=$1", [hash(raw)]);
      await db.query(`INSERT INTO folder_grants(token_hash,link_hash,folder_id,access,expires_at,session_hash)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(link_hash,session_hash) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at`,
        [hash(value), hash(raw), link.folder_id, link.access, expiresAt, session]);
      return { grant: value, folderId: link.folder_id, access: link.access, expiresAt, singleUse: link.max_uses === 1 };
    });
    res.json(result);
  }));
  return router;
}
