import { createHash, randomBytes, randomUUID } from "crypto";
import {
  ACCESS_LEVELS,
  Access,
  CreatedFolderLink,
  Document,
  FolderLink,
  FolderMember,
  JoinResult,
  Library,
  LinkPreview,
  DocumentVersion,
  DocumentVersionContent,
  Role,
  SearchResult,
  TrashedDocument,
  canEditDocuments,
  canManageFolder,
  rank,
} from "../domain/library";
import { AppError, NotFoundError, ValidationError } from "../errors";
import { Db, DocumentChanges, DocumentRecord, LinkRecord, PgLibraryRepository } from "../repositories/libraryRepository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK_TOKEN = /^[A-Za-z0-9_-]{30,100}$/;
const LINK_ID = /^[0-9a-f]{64}$/;
const LINK_DAYS = [1, 7, 30];
const MAX_ACTIVE_LINKS = 50;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const forbidden = (message = "برای این کار به پوشه دسترسی ندارید.") => new AppError(403, "FORBIDDEN", message);
const folderNotFound = () => new NotFoundError("پوشه پیدا نشد یا دیگر به آن دسترسی ندارید.");
const documentNotFound = () => new NotFoundError("متن پیدا نشد یا دیگر به آن دسترسی ندارید.");
const conflict = () => new AppError(409, "VERSION_CONFLICT", "این متن در جای دیگری تغییر کرده است.");
const linkUnavailable = () => new AppError(410, "LINK_UNAVAILABLE", "این لینک لغو شده یا وجود ندارد.");
const linkExpired = () => new AppError(410, "LINK_EXPIRED", "زمان این لینک به پایان رسیده است؛ از مالک پوشه لینک تازه بگیرید.");
const linkUsed = () => new AppError(410, "LINK_USED", "این لینک یک‌بارمصرف قبلاً استفاده شده است؛ از مالک پوشه لینک تازه بگیرید.");

function id(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new ValidationError(`Invalid ${label}`);
  return value.toLowerCase();
}
function optionalFolderId(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : id(value, "folderId");
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new ValidationError(`${field} must be 1–${max} characters`);
  }
  return value.trim();
}
function version(value: unknown): number {
  if (value === undefined || value === null) {
    throw new AppError(428, "VERSION_REQUIRED", "نسخهٔ متن فرستاده نشده است؛ متن را دوباره باز کنید.");
  }
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) throw new ValidationError("Invalid version");
  return parsed;
}
function isExpired(link: LinkRecord): boolean {
  return !!link.expiresAt && link.expiresAt.getTime() <= Date.now();
}

/**
 * Saved documents, folders and folder sharing.
 *
 * A document lives in the library of the user who saved it, either unfiled or
 * in one of their folders; a document inside a folder always belongs to the
 * folder's owner. Folders are shared through links: opening a link makes the
 * visitor a member with the link's access until the owner removes them or
 * revokes the link.
 */
export class LibraryService {
  constructor(
    private readonly repository: PgLibraryRepository,
    private readonly maxContentLength: number
  ) {}

  async library(userId: string): Promise<Library> {
    const [folders, documents] = await Promise.all([
      this.repository.listFolders(userId),
      this.repository.listDocuments(userId),
    ]);
    return { folders, documents };
  }

  /** Finds documents whose title or text contains the query. */
  async search(userId: string, query: unknown): Promise<SearchResult[]> {
    if (typeof query !== "string") throw new ValidationError("Query is required");
    const needle = query.trim().replace(/ي/g, "ی").replace(/ك/g, "ک").toLowerCase();
    if (needle.length < 2 || needle.length > 100) throw new ValidationError("Query must be 2–100 characters");
    await this.limit(`search:${userId}`, 120);
    return this.repository.searchDocuments(userId, needle, 50);
  }

  // --- documents ---

  async getDocument(userId: string, documentId: unknown): Promise<Document> {
    const document = await this.repository.findDocument(id(documentId));
    if (!document) throw documentNotFound();
    const role = await this.documentRole(userId, document);
    if (!role) throw documentNotFound();
    return this.present(document, role);
  }

  async createDocument(userId: string, input: { title?: unknown; content?: unknown; folderId?: unknown }): Promise<Document> {
    const title = text(input.title, "Title", 200);
    const content = this.content(input.content);
    const folderId = optionalFolderId(input.folderId);
    let ownerId = userId;
    let role: Role = "owner";
    if (folderId) {
      const folder = await this.repository.folderAccess(folderId, userId);
      if (!folder?.role) throw folderNotFound();
      if (!canEditDocuments(folder.role)) throw forbidden("دسترسی این پوشه فقط خواندنی است.");
      ownerId = folder.ownerId;
      role = folder.role;
    }
    const document = await this.repository.insertDocument(randomUUID(), ownerId, folderId, title, content);
    return this.present(document, role);
  }

  async updateDocument(userId: string, documentId: unknown, input: { title?: unknown; content?: unknown; folderId?: unknown; version?: unknown }): Promise<Document> {
    const targetId = id(documentId);
    const expected = version(input.version);
    const changes: DocumentChanges = {};
    if (input.title !== undefined) changes.title = text(input.title, "Title", 200);
    if (input.content !== undefined) changes.content = this.content(input.content);
    if (input.folderId !== undefined) changes.folderId = optionalFolderId(input.folderId);
    if (!Object.keys(changes).length) throw new ValidationError("No changes supplied");

    return this.repository.transaction(async db => {
      // Lock the row so access, version and the write are checked together.
      const document = await this.repository.findDocument(targetId, db, true);
      if (!document) throw documentNotFound();
      const role = await this.documentRole(userId, document, db);
      if (!role) throw documentNotFound();
      if (!canEditDocuments(role)) throw forbidden("دسترسی این پوشه فقط خواندنی است.");
      if (document.version !== expected) throw conflict();
      if (changes.folderId !== undefined && changes.folderId !== document.folderId) {
        await this.assertCanMove(userId, document, changes.folderId, db);
      }
      if (changes.title !== undefined || changes.content !== undefined) await this.repository.archiveVersion(targetId, db);
      const updated = await this.repository.updateDocument(targetId, changes, db);
      return this.present(updated, await this.documentRole(userId, updated, db) ?? role);
    });
  }

  async deleteDocument(userId: string, documentId: unknown, expectedVersion: unknown): Promise<void> {
    const targetId = id(documentId);
    const expected = version(expectedVersion);
    await this.repository.transaction(async db => {
      const document = await this.repository.findDocument(targetId, db, true);
      if (!document) throw documentNotFound();
      const role = await this.documentRole(userId, document, db);
      if (!role) throw documentNotFound();
      if (!canEditDocuments(role)) throw forbidden("دسترسی این پوشه فقط خواندنی است.");
      if (document.version !== expected) throw conflict();
      await this.repository.deleteDocument(targetId, db);
    });
  }

  // --- versions and trash ---

  async listVersions(userId: string, documentId: unknown): Promise<DocumentVersion[]> {
    const document = await this.readable(userId, documentId);
    return this.repository.listVersions(document.id);
  }

  async getVersion(userId: string, documentId: unknown, versionNumber: unknown): Promise<DocumentVersionContent> {
    const document = await this.readable(userId, documentId);
    const found = await this.repository.findVersion(document.id, version(versionNumber));
    if (!found) throw new NotFoundError("این نسخه پیدا نشد.");
    return found;
  }

  async listTrash(userId: string): Promise<TrashedDocument[]> {
    return this.repository.listTrash(userId);
  }

  async restoreDocument(userId: string, documentId: unknown): Promise<Document> {
    return this.repository.transaction(async db => {
      const document = await this.trashed(userId, documentId, db);
      const restored = await this.repository.restoreDocument(document.id, db);
      return this.present(restored, await this.documentRole(userId, restored, db) ?? "owner");
    });
  }

  async purgeDocument(userId: string, documentId: unknown): Promise<void> {
    await this.repository.transaction(async db => {
      const document = await this.trashed(userId, documentId, db);
      await this.repository.purgeDocument(document.id, db);
    });
  }

  // --- folders ---

  async createFolder(userId: string, input: { name?: unknown }): Promise<{ id: string; name: string; role: Role }> {
    const name = text(input.name, "Name", 100);
    const folderId = randomUUID();
    await this.repository.createFolder(folderId, userId, name);
    return { id: folderId, name, role: "owner" };
  }

  async renameFolder(userId: string, folderId: unknown, input: { name?: unknown }): Promise<{ id: string; name: string }> {
    const target = id(folderId);
    const name = text(input.name, "Name", 100);
    await this.requireRole(userId, target, canManageFolder);
    await this.repository.renameFolder(target, name);
    return { id: target, name };
  }

  async deleteFolder(userId: string, folderId: unknown, withDocuments: boolean): Promise<void> {
    const target = id(folderId);
    await this.repository.transaction(async db => {
      await this.requireRole(userId, target, canManageFolder, db, true);
      await this.repository.deleteFolder(target, withDocuments, db);
    });
  }

  /** A member removes a shared folder from their own library. */
  async leaveFolder(userId: string, folderId: unknown): Promise<void> {
    const target = id(folderId);
    const folder = await this.repository.folderAccess(target, userId);
    if (!folder?.role) throw folderNotFound();
    if (folder.role === "owner") throw new ValidationError("Owners cannot leave their own folder");
    await this.repository.deleteMember(target, userId);
  }

  // --- sharing (owner only) ---

  async createLink(userId: string, folderId: unknown, input: { access?: unknown; singleUse?: unknown; label?: unknown; expiresInDays?: unknown }): Promise<CreatedFolderLink> {
    const target = id(folderId);
    const access = input.access as Access;
    if (!ACCESS_LEVELS.includes(access)) throw new ValidationError("Invalid access");
    if (typeof input.singleUse !== "boolean") throw new ValidationError("Invalid use limit");
    const days = input.expiresInDays ?? 7;
    if (typeof days !== "number" || !LINK_DAYS.includes(days)) throw new ValidationError("Invalid expiry");
    const label = input.label === undefined || input.label === null || input.label === "" ? "" : text(input.label, "Label", 100);
    await this.limit(`create:${userId}`, 20);

    const token = randomBytes(32).toString("base64url");
    const link = await this.repository.transaction(async db => {
      await this.requireRole(userId, target, role => role === "owner", db, true);
      if (await this.repository.countActiveLinks(target, db) >= MAX_ACTIVE_LINKS) {
        throw new AppError(409, "LINK_LIMIT", "هر پوشه تا ۵۰ لینک فعال دارد؛ ابتدا لینک‌های اضافی را لغو کنید.");
      }
      return this.repository.insertLink(hash(token), target, access, input.singleUse as boolean, label, days, db);
    });
    return { ...link, token };
  }

  async listLinks(userId: string, folderId: unknown): Promise<FolderLink[]> {
    const target = id(folderId);
    await this.requireRole(userId, target, role => role === "owner");
    return this.repository.listLinks(target);
  }

  async revokeLink(userId: string, folderId: unknown, linkId: unknown): Promise<void> {
    const target = id(folderId);
    if (typeof linkId !== "string" || !LINK_ID.test(linkId)) throw new ValidationError("Invalid link id");
    await this.repository.transaction(async db => {
      await this.requireRole(userId, target, role => role === "owner", db, true);
      if (!await this.repository.deleteLink(target, linkId, db)) throw new NotFoundError("لینک پیدا نشد.");
    });
  }

  async listMembers(userId: string, folderId: unknown): Promise<FolderMember[]> {
    const target = id(folderId);
    await this.requireRole(userId, target, role => role === "owner");
    return this.repository.listMembers(target);
  }

  async removeMember(userId: string, folderId: unknown, memberId: unknown): Promise<void> {
    const target = id(folderId);
    const member = id(memberId, "member id");
    await this.requireRole(userId, target, role => role === "owner");
    if (!await this.repository.deleteMember(target, member)) throw new NotFoundError("این عضو پیدا نشد.");
  }

  // --- link visitors ---

  /** Describes a link without consuming it. */
  async previewLink(userId: string | null, token: unknown): Promise<LinkPreview> {
    const link = await this.findLink(token);
    const role = userId ? (await this.repository.folderAccess(link.folderId, userId))?.role ?? null : null;
    if (!role) this.assertJoinable(link);
    return {
      folderId: link.folderId,
      name: link.folderName,
      access: link.access,
      singleUse: link.maxUses === 1,
      expiresAt: link.expiresAt,
      role,
    };
  }

  /**
   * Joins the folder behind a link. Joining again (another tab, a retried
   * request) keeps the existing membership and does not consume a single-use
   * link twice; a link with more access upgrades it.
   */
  async joinLink(userId: string, token: unknown): Promise<JoinResult> {
    if (typeof token !== "string" || !LINK_TOKEN.test(token)) throw linkUnavailable();
    const linkHash = hash(token);
    await this.limit(`join-user:${userId}`, 60);
    await this.limit(`join-link:${linkHash}`, 120);
    return this.repository.transaction(async db => {
      const link = await this.repository.findLink(linkHash, db, true);
      if (!link) throw linkUnavailable();
      const current = (await this.repository.folderAccess(link.folderId, userId, db))?.role ?? null;
      if (current && rank(current) >= rank(link.access)) {
        await this.repository.recordLinkUse(link.hash, false, db);
        return { folderId: link.folderId, role: current };
      }
      this.assertJoinable(link);
      await this.repository.upsertMember(link.folderId, userId, link.access, link.hash, db);
      await this.repository.recordLinkUse(link.hash, true, db);
      return { folderId: link.folderId, role: link.access };
    });
  }

  async cleanup(): Promise<void> {
    await this.repository.cleanup();
  }

  // --- helpers ---

  private content(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || value.length > this.maxContentLength) {
      throw new ValidationError(`Content must be 1–${this.maxContentLength} characters`);
    }
    return value;
  }

  private async readable(userId: string, documentId: unknown): Promise<DocumentRecord> {
    const document = await this.repository.findDocument(id(documentId));
    if (!document || !await this.documentRole(userId, document)) throw documentNotFound();
    return document;
  }

  /** A trashed document the user may restore or delete for good. */
  private async trashed(userId: string, documentId: unknown, db: Db): Promise<DocumentRecord> {
    const document = await this.repository.findDocument(id(documentId), db, true, true);
    if (!document) throw documentNotFound();
    const role = document.ownerId === userId ? "owner" : await this.documentRole(userId, document, db);
    if (!role || !canEditDocuments(role)) throw documentNotFound();
    return document;
  }

  private async documentRole(userId: string, document: DocumentRecord, db?: Db): Promise<Role | null> {
    if (!document.folderId) return document.ownerId === userId ? "owner" : null;
    return (await this.repository.folderAccess(document.folderId, userId, db))?.role ?? null;
  }

  private async requireRole(userId: string, folderId: string, allowed: (role: Role) => boolean, db?: Db, lock = false): Promise<Role> {
    const folder = await this.repository.folderAccess(folderId, userId, db, lock);
    if (!folder?.role) throw folderNotFound();
    if (!allowed(folder.role)) throw forbidden();
    return folder.role;
  }

  /**
   * Documents move only within one owner's library: into another folder the
   * user can edit that belongs to the same owner, or out of folders (owner only).
   */
  private async assertCanMove(userId: string, document: DocumentRecord, folderId: string | null, db: Db): Promise<void> {
    if (!folderId) {
      if (document.ownerId !== userId) throw forbidden("فقط مالک می‌تواند متن را از پوشهٔ اشتراکی بیرون ببرد.");
      return;
    }
    const target = await this.repository.folderAccess(folderId, userId, db);
    if (!target?.role) throw folderNotFound();
    if (!canEditDocuments(target.role)) throw forbidden("پوشهٔ مقصد فقط خواندنی است.");
    if (target.ownerId !== document.ownerId) {
      throw forbidden("انتقال بین کتابخانه‌های افراد مختلف ممکن نیست؛ به‌جای آن یک نسخه ذخیره کنید.");
    }
  }

  private async findLink(token: unknown): Promise<LinkRecord> {
    if (typeof token !== "string" || !LINK_TOKEN.test(token)) throw linkUnavailable();
    const link = await this.repository.findLink(hash(token));
    if (!link) throw linkUnavailable();
    return link;
  }

  private assertJoinable(link: LinkRecord): void {
    if (isExpired(link)) throw linkExpired();
    if (link.maxUses !== null && link.useCount >= link.maxUses) throw linkUsed();
  }

  private async limit(key: string, maximum: number): Promise<void> {
    if (await this.repository.hit(key) > maximum) {
      throw new AppError(429, "RATE_LIMIT", "درخواست‌ها زیاد است؛ یک دقیقه بعد دوباره تلاش کنید.");
    }
  }

  private present(document: DocumentRecord, role: Role): Document {
    return {
      id: document.id,
      folderId: document.folderId,
      title: document.title,
      content: document.content,
      version: document.version,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      role,
    };
  }
}
