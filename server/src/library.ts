import { Router, Request, Response, NextFunction } from "express";
import { Pool } from "pg";
import { randomUUID } from "crypto";
import { AuthRouter, hash, token } from "./auth";
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
const forbidden = () => new AppError(403, "FORBIDDEN", "No access to this folder");
type Grant = { folder_id: string; access: "read" | "full" };

export function createLibraryRouter(pool: Pool, auth: AuthRouter, maxContentLength: number): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const wrap = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { handler(req, res).catch(next); };
  async function owner(req: Request, res: Response): Promise<string> { return (await auth.principal(req, res))!.id; }
  async function grant(req: Request): Promise<Grant | null> {
    const raw = req.get("X-Folder-Grant");
    if (!raw || !/^[A-Za-z0-9_-]{30,100}$/.test(raw)) return null;
    const result = await pool.query<Grant>("SELECT folder_id,access FROM folder_grants WHERE token_hash=$1 AND expires_at>now()", [hash(raw)]);
    return result.rows[0] ?? null;
  }
  async function canWrite(req: Request, res: Response, folderId: string): Promise<void> {
    const who = await auth.principal(req, res, false);
    if (who) {
      const found = await pool.query("SELECT 1 FROM folders WHERE id=$1 AND owner_id=$2", [folderId, who.id]);
      if (found.rows.length) return;
    }
    const access = await grant(req);
    if (access?.folder_id === folderId && access.access === "full") return;
    throw forbidden();
  }
  async function canRead(req: Request, res: Response, folderId: string): Promise<void> {
    const who = await auth.principal(req, res, false);
    if (who) {
      const found = await pool.query("SELECT 1 FROM folders WHERE id=$1 AND owner_id=$2", [folderId, who.id]);
      if (found.rows.length) return;
    }
    const access = await grant(req);
    if (access?.folder_id === folderId) return;
    throw forbidden();
  }
  router.get("/library", wrap(async (req, res) => {
    const id = await owner(req, res);
    const [folders, items] = await Promise.all([
      pool.query("SELECT id,name,created_at FROM folders WHERE owner_id=$1 ORDER BY created_at DESC", [id]),
      pool.query("SELECT id,folder_id,title,content,created_at,updated_at FROM saved_items WHERE owner_id=$1 ORDER BY updated_at DESC", [id])
    ]);
    res.json({ folders: folders.rows, items: items.rows });
  }));
  router.post("/folders", wrap(async (req, res) => {
    const id = randomUUID(); const who = await owner(req, res);
    const result = await pool.query("INSERT INTO folders(id,owner_id,name) VALUES($1,$2,$3) RETURNING id,name,created_at", [id, who, name(req.body?.name)]);
    res.status(201).json(result.rows[0]);
  }));
  router.patch("/folders/:id", wrap(async (req, res) => {
    const id = uuid(req.params.id); await canWrite(req, res, id);
    const result = await pool.query("UPDATE folders SET name=$1 WHERE id=$2 RETURNING id,name,created_at", [name(req.body?.name), id]);
    if (!result.rows[0]) throw new NotFoundError(); res.json(result.rows[0]);
  }));
  router.delete("/folders/:id", wrap(async (req, res) => {
    const id = uuid(req.params.id); await canWrite(req, res, id);
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
    const result = await pool.query("INSERT INTO saved_items(id,owner_id,folder_id,title,content) VALUES($1,$2,$3,$4,$5) RETURNING id,folder_id,title,content,created_at,updated_at", [randomUUID(), ownerId, folderId, itemTitle, text]);
    res.status(201).json(result.rows[0]);
  }));
  router.patch("/items/:id", wrap(async (req, res) => {
    const id = uuid(req.params.id);
    const existing = await pool.query<{ owner_id: string; folder_id: string | null; title: string; content: string }>("SELECT owner_id,folder_id,title,content FROM saved_items WHERE id=$1", [id]);
    const item = existing.rows[0]; if (!item) throw new NotFoundError();
    const who = await auth.principal(req, res, false);
    const isOwner = who?.id === item.owner_id;
    if (!isOwner) { if (!item.folder_id) throw forbidden(); await canWrite(req, res, item.folder_id); }
    const folderId = req.body?.folderId === undefined ? item.folder_id : req.body.folderId === null ? null : uuid(req.body.folderId);
    if (folderId !== item.folder_id) {
      if (!isOwner || (folderId && !(await pool.query("SELECT 1 FROM folders WHERE id=$1 AND owner_id=$2", [folderId, item.owner_id])).rows.length)) throw forbidden();
    }
    const updated = await pool.query("UPDATE saved_items SET title=$1,content=$2,folder_id=$3,updated_at=now() WHERE id=$4 RETURNING id,folder_id,title,content,created_at,updated_at", [req.body?.title === undefined ? item.title : title(req.body.title), req.body?.content === undefined ? item.content : content(req.body.content, maxContentLength), folderId, id]);
    res.json(updated.rows[0]);
  }));
  router.delete("/items/:id", wrap(async (req, res) => {
    const id = uuid(req.params.id);
    const result = await pool.query<{ owner_id: string; folder_id: string | null }>("SELECT owner_id,folder_id FROM saved_items WHERE id=$1", [id]);
    const item = result.rows[0]; if (!item) throw new NotFoundError();
    const who = await auth.principal(req, res, false);
    if (who?.id !== item.owner_id) { if (!item.folder_id) throw forbidden(); await canWrite(req, res, item.folder_id); }
    await pool.query("DELETE FROM saved_items WHERE id=$1", [id]); res.status(204).end();
  }));
  router.get("/folders/:id", wrap(async (req, res) => {
    const id = uuid(req.params.id); await canRead(req, res, id);
    const [folder, items] = await Promise.all([
      pool.query("SELECT id,name,created_at FROM folders WHERE id=$1", [id]),
      pool.query("SELECT id,folder_id,title,content,created_at,updated_at FROM saved_items WHERE folder_id=$1 ORDER BY updated_at DESC", [id])
    ]);
    if (!folder.rows[0]) throw new NotFoundError();
    const access = await grant(req);
    res.json({ folder: folder.rows[0], items: items.rows, access: access?.folder_id === id ? access.access : "full" });
  }));
  router.post("/folders/:id/links", wrap(async (req, res) => {
    const id = uuid(req.params.id); const who = await owner(req, res);
    const owned = await pool.query("SELECT 1 FROM folders WHERE id=$1 AND owner_id=$2", [id, who]);
    if (!owned.rows.length) throw forbidden();
    const access = req.body?.access;
    const singleUse = req.body?.singleUse;
    if (access !== "read" && access !== "full") throw new ValidationError("Invalid access");
    if (typeof singleUse !== "boolean") throw new ValidationError("Invalid use limit");
    const value = token();
    await pool.query("INSERT INTO folder_links(token_hash,folder_id,access,max_uses) VALUES($1,$2,$3,$4)", [hash(value), id, access, singleUse ? 1 : null]);
    res.status(201).json({ token: value, access, singleUse });
  }));
  router.get("/folders/:id/links", wrap(async (req, res) => {
    const id = uuid(req.params.id); const who = await owner(req, res);
    const owned = await pool.query("SELECT 1 FROM folders WHERE id=$1 AND owner_id=$2", [id, who]);
    if (!owned.rows.length) throw forbidden();
    const links = await pool.query("SELECT token_hash,access,max_uses,use_count,created_at FROM folder_links WHERE folder_id=$1 ORDER BY created_at DESC", [id]);
    res.json({ links: links.rows });
  }));
  router.delete("/folders/:id/links/:hash", wrap(async (req, res) => {
    const id = uuid(req.params.id); const who = await owner(req, res);
    if (!/^[0-9a-f]{64}$/.test(req.params.hash ?? "")) throw new ValidationError("Invalid link id");
    const result = await pool.query("DELETE FROM folder_links l USING folders f WHERE l.token_hash=$1 AND l.folder_id=$2 AND f.id=l.folder_id AND f.owner_id=$3", [req.params.hash, id, who]);
    if (!result.rowCount) throw new NotFoundError(); res.status(204).end();
  }));
  router.post("/folder-links/:token/redeem", wrap(async (req, res) => {
    const raw = req.params.token ?? "";
    if (!/^[A-Za-z0-9_-]{30,100}$/.test(raw)) throw new NotFoundError();
    const value = token();
    const result = await pool.query<Grant>(`
      WITH redeemed AS (
        UPDATE folder_links SET use_count=use_count+1
        WHERE token_hash=$1 AND (max_uses IS NULL OR use_count<max_uses)
        RETURNING token_hash,folder_id,access
      ), issued AS (
        INSERT INTO folder_grants(token_hash,link_hash,folder_id,access,expires_at)
        SELECT $2,token_hash,folder_id,access,now()+interval '24 hours' FROM redeemed
        RETURNING folder_id,access
      ) SELECT folder_id,access FROM issued
    `, [hash(raw), hash(value)]);
    const link = result.rows[0]; if (!link) throw new NotFoundError("Link not found or already used");
    res.json({ grant: value, folderId: link.folder_id, access: link.access });
  }));
  return router;
}
