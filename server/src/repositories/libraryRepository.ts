import { Pool, PoolClient, QueryResultRow } from "pg";
import {
  Access,
  DocumentSummary,
  FolderLink,
  FolderMember,
  FolderSummary,
  DocumentVersion,
  DocumentVersionContent,
  Role,
  SearchResult,
  TrashedDocument,
} from "../domain/library";

/** Either the pool or a client inside a transaction. */
export type Db = Pool | PoolClient;

/** A stored document row, including the fields authorization needs. */
export interface DocumentRecord extends DocumentSummary {
  readonly ownerId: string;
  readonly content: string;
}

/** Who owns a folder and what the given user is to it (null: no access). */
export interface FolderAccess {
  readonly ownerId: string;
  readonly name: string;
  readonly role: Role | null;
}

export interface LinkRecord {
  readonly hash: string;
  readonly folderId: string;
  readonly folderName: string;
  readonly ownerId: string;
  readonly access: Access;
  readonly maxUses: number | null;
  readonly useCount: number;
  readonly expiresAt: Date | null;
}

export interface DocumentChanges {
  title?: string;
  content?: string;
  folderId?: string | null;
}

interface DocumentRow extends QueryResultRow {
  id: string;
  owner_id: string;
  folder_id: string | null;
  title: string;
  content: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const DOCUMENT_COLUMNS = "id, owner_id, folder_id, title, content, version, created_at, updated_at";
const MAX_VERSIONS = 50;

function toSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRecord(row: DocumentRow): DocumentRecord {
  return { ...toSummary(row), ownerId: row.owner_id, content: row.content };
}

function toLink(row: QueryResultRow): FolderLink {
  return {
    id: row.token_hash,
    label: row.label,
    access: row.access,
    singleUse: row.max_uses === 1,
    useCount: row.use_count,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  };
}

/** Postgres access for folders, documents, share links and memberships. */
export class PgLibraryRepository {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await work(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  // --- library ---

  async listFolders(userId: string): Promise<FolderSummary[]> {
    const { rows } = await this.pool.query(
      `SELECT f.id, f.name, f.created_at, f.updated_at,
         CASE WHEN f.owner_id = $1 THEN 'owner' ELSE m.access END AS role,
         (SELECT count(*) FROM saved_items i WHERE i.folder_id = f.id AND i.deleted_at IS NULL)::int AS document_count,
         CASE WHEN f.owner_id = $1
           THEN (SELECT count(*) FROM folder_members x WHERE x.folder_id = f.id)::int
           ELSE 0 END AS member_count
       FROM folders f
       LEFT JOIN folder_members m ON m.folder_id = f.id AND m.member_id = $1
       WHERE f.owner_id = $1 OR m.member_id IS NOT NULL
       ORDER BY lower(f.name), f.created_at`,
      [userId]
    );
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      role: row.role,
      documentCount: row.document_count,
      memberCount: row.member_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async listDocuments(userId: string): Promise<DocumentSummary[]> {
    const { rows } = await this.pool.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM saved_items i
       WHERE i.deleted_at IS NULL AND (
            (i.folder_id IS NULL AND i.owner_id = $1)
          OR i.folder_id IN (SELECT id FROM folders WHERE owner_id = $1)
          OR i.folder_id IN (SELECT folder_id FROM folder_members WHERE member_id = $1))
       ORDER BY i.updated_at DESC`,
      [userId]
    );
    return rows.map(toSummary);
  }

  /**
   * Case-insensitive search in titles and bodies of every document the user
   * can open. Arabic ي/ك are folded to Persian ی/ک on both sides, so either
   * spelling finds the other. `needle` must already be lowercased and folded.
   */
  async searchDocuments(userId: string, needle: string, limit: number): Promise<SearchResult[]> {
    const { rows } = await this.pool.query(
      `WITH accessible AS (
         SELECT id, folder_id, title, content, updated_at,
           strpos(lower(translate(title, 'يك', 'یک')), $2) AS title_at,
           strpos(lower(translate(content, 'يك', 'یک')), $2) AS content_at
         FROM saved_items i
         WHERE i.deleted_at IS NULL AND (
              (i.folder_id IS NULL AND i.owner_id = $1)
            OR i.folder_id IN (SELECT id FROM folders WHERE owner_id = $1)
            OR i.folder_id IN (SELECT folder_id FROM folder_members WHERE member_id = $1))
       )
       SELECT id, folder_id, title, updated_at,
         CASE WHEN content_at > 0
           THEN substring(content FROM greatest(content_at - 60, 1) FOR 160)
           ELSE left(content, 160) END AS snippet,
         content_at > 0 AND content_at > 61 AS clipped
       FROM accessible
       WHERE title_at > 0 OR content_at > 0
       ORDER BY (title_at > 0) DESC, updated_at DESC
       LIMIT $3`,
      [userId, needle, limit]
    );
    return rows.map(row => ({
      id: row.id,
      folderId: row.folder_id,
      title: row.title,
      snippet: `${row.clipped ? "…" : ""}${row.snippet.replace(/\s+/g, " ").trim()}`,
      updatedAt: row.updated_at,
    }));
  }

  // --- folders ---

  async folderAccess(folderId: string, userId: string, db: Db = this.pool, lock = false): Promise<FolderAccess | null> {
    const { rows } = await db.query(
      `SELECT f.owner_id, f.name, CASE WHEN f.owner_id = $2 THEN 'owner' ELSE m.access END AS role
       FROM folders f
       LEFT JOIN folder_members m ON m.folder_id = f.id AND m.member_id = $2
       WHERE f.id = $1${lock ? " FOR UPDATE OF f" : ""}`,
      [folderId, userId]
    );
    const row = rows[0];
    return row ? { ownerId: row.owner_id, name: row.name, role: row.role } : null;
  }

  async createFolder(id: string, ownerId: string, name: string): Promise<void> {
    await this.pool.query("INSERT INTO folders(id, owner_id, name) VALUES($1, $2, $3)", [id, ownerId, name]);
  }

  async renameFolder(id: string, name: string): Promise<void> {
    await this.pool.query("UPDATE folders SET name = $2, updated_at = now() WHERE id = $1", [id, name]);
  }

  /** Deletes a folder. Its documents go to the trash too, or stay unfiled for the owner. */
  async deleteFolder(id: string, withDocuments: boolean, db: Db): Promise<void> {
    if (withDocuments) await db.query("UPDATE saved_items SET deleted_at = now() WHERE folder_id = $1 AND deleted_at IS NULL", [id]);
    await db.query("DELETE FROM folders WHERE id = $1", [id]);
  }

  // --- documents ---

  async findDocument(id: string, db: Db = this.pool, lock = false, trashed = false): Promise<DocumentRecord | null> {
    const { rows } = await db.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM saved_items
       WHERE id = $1 AND deleted_at IS ${trashed ? "NOT NULL" : "NULL"}${lock ? " FOR UPDATE" : ""}`,
      [id]
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async insertDocument(id: string, ownerId: string, folderId: string | null, title: string, content: string): Promise<DocumentRecord> {
    const { rows } = await this.pool.query<DocumentRow>(
      `INSERT INTO saved_items(id, owner_id, folder_id, title, content)
       VALUES($1, $2, $3, $4, $5) RETURNING ${DOCUMENT_COLUMNS}`,
      [id, ownerId, folderId, title, content]
    );
    return toRecord(rows[0]!);
  }

  async updateDocument(id: string, changes: DocumentChanges, db: Db): Promise<DocumentRecord> {
    const values: unknown[] = [id];
    const fields: string[] = [];
    const set = (column: string, value: unknown) => { values.push(value); fields.push(`${column} = $${values.length}`); };
    if (changes.title !== undefined) set("title", changes.title);
    if (changes.content !== undefined) set("content", changes.content);
    if (changes.folderId !== undefined) set("folder_id", changes.folderId);
    const { rows } = await db.query<DocumentRow>(
      `UPDATE saved_items SET ${fields.join(", ")}, version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING ${DOCUMENT_COLUMNS}`,
      values
    );
    return toRecord(rows[0]!);
  }

  /** Keeps the current title and body as a version before they change. */
  async archiveVersion(id: string, db: Db): Promise<void> {
    await db.query(
      `INSERT INTO document_versions(document_id, version, title, content, saved_at)
       SELECT id, version, title, content, updated_at FROM saved_items WHERE id = $1
       ON CONFLICT DO NOTHING`,
      [id]
    );
    await db.query(
      `DELETE FROM document_versions WHERE document_id = $1 AND version <=
         (SELECT max(version) - $2 FROM document_versions WHERE document_id = $1)`,
      [id, MAX_VERSIONS]
    );
  }

  async listVersions(id: string): Promise<DocumentVersion[]> {
    const { rows } = await this.pool.query(
      `SELECT version, title, saved_at, length(content) AS length FROM document_versions
       WHERE document_id = $1 ORDER BY version DESC`,
      [id]
    );
    return rows.map(row => ({ version: row.version, title: row.title, savedAt: row.saved_at, length: row.length }));
  }

  async findVersion(id: string, version: number): Promise<DocumentVersionContent | null> {
    const { rows } = await this.pool.query(
      "SELECT version, title, content, saved_at FROM document_versions WHERE document_id = $1 AND version = $2",
      [id, version]
    );
    const row = rows[0];
    return row ? { version: row.version, title: row.title, content: row.content, savedAt: row.saved_at, length: row.content.length } : null;
  }

  /** Moves a document to the trash. */
  async deleteDocument(id: string, db: Db): Promise<void> {
    await db.query("UPDATE saved_items SET deleted_at = now() WHERE id = $1", [id]);
  }

  /** Deleted documents the user may restore: their own, or in folders they can edit. */
  async listTrash(userId: string): Promise<TrashedDocument[]> {
    const { rows } = await this.pool.query<DocumentRow & { deleted_at: Date }>(
      `SELECT ${DOCUMENT_COLUMNS}, deleted_at FROM saved_items i
       WHERE i.deleted_at IS NOT NULL AND (
            i.owner_id = $1
         OR i.folder_id IN (SELECT folder_id FROM folder_members WHERE member_id = $1 AND access IN ('edit', 'full')))
       ORDER BY i.deleted_at DESC`,
      [userId]
    );
    return rows.map(row => ({ ...toSummary(row), deletedAt: row.deleted_at }));
  }

  async restoreDocument(id: string, db: Db): Promise<DocumentRecord> {
    const { rows } = await db.query<DocumentRow>(
      `UPDATE saved_items SET deleted_at = NULL, updated_at = now() WHERE id = $1 RETURNING ${DOCUMENT_COLUMNS}`,
      [id]
    );
    return toRecord(rows[0]!);
  }

  async purgeDocument(id: string, db: Db): Promise<void> {
    await db.query("DELETE FROM saved_items WHERE id = $1", [id]);
  }

  // --- share links ---

  async countActiveLinks(folderId: string, db: Db): Promise<number> {
    const { rows } = await db.query(
      "SELECT count(*)::int AS count FROM folder_links WHERE folder_id = $1 AND (expires_at IS NULL OR expires_at > now())",
      [folderId]
    );
    return rows[0].count;
  }

  async insertLink(hash: string, folderId: string, access: Access, singleUse: boolean, label: string, days: number, db: Db): Promise<FolderLink> {
    const { rows } = await db.query(
      `INSERT INTO folder_links(token_hash, folder_id, access, max_uses, label, expires_at)
       VALUES($1, $2, $3, $4, $5, now() + ($6 * interval '1 day')) RETURNING *`,
      [hash, folderId, access, singleUse ? 1 : null, label, days]
    );
    return toLink(rows[0]);
  }

  async listLinks(folderId: string): Promise<FolderLink[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM folder_links WHERE folder_id = $1 ORDER BY created_at DESC",
      [folderId]
    );
    return rows.map(toLink);
  }

  async findLink(hash: string, db: Db = this.pool, lock = false): Promise<LinkRecord | null> {
    const { rows } = await db.query(
      `SELECT l.*, f.name AS folder_name, f.owner_id FROM folder_links l
       JOIN folders f ON f.id = l.folder_id WHERE l.token_hash = $1${lock ? " FOR UPDATE OF l" : ""}`,
      [hash]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      hash: row.token_hash,
      folderId: row.folder_id,
      folderName: row.folder_name,
      ownerId: row.owner_id,
      access: row.access,
      maxUses: row.max_uses,
      useCount: row.use_count,
      expiresAt: row.expires_at,
    };
  }

  async recordLinkUse(hash: string, consumed: boolean, db: Db): Promise<void> {
    await db.query(
      `UPDATE folder_links SET last_used_at = now()${consumed ? ", use_count = use_count + 1" : ""} WHERE token_hash = $1`,
      [hash]
    );
  }

  /** Revokes a link and the access of everyone who joined through it. */
  async deleteLink(folderId: string, hash: string, db: Db): Promise<boolean> {
    await db.query("DELETE FROM folder_members WHERE folder_id = $1 AND link_hash = $2", [folderId, hash]);
    const result = await db.query("DELETE FROM folder_links WHERE folder_id = $1 AND token_hash = $2", [folderId, hash]);
    return (result.rowCount ?? 0) > 0;
  }

  // --- members ---

  async listMembers(folderId: string): Promise<FolderMember[]> {
    const { rows } = await this.pool.query(
      `SELECT m.member_id, m.access, m.joined_at, o.email IS NOT NULL AS registered, l.label AS link_label
       FROM folder_members m
       JOIN owners o ON o.id = m.member_id
       LEFT JOIN folder_links l ON l.token_hash = m.link_hash
       WHERE m.folder_id = $1 ORDER BY m.joined_at DESC`,
      [folderId]
    );
    return rows.map(row => ({
      id: row.member_id,
      access: row.access,
      registered: row.registered,
      linkLabel: row.link_label,
      joinedAt: row.joined_at,
    }));
  }

  async upsertMember(folderId: string, memberId: string, access: Access, linkHash: string, db: Db): Promise<void> {
    await db.query(
      `INSERT INTO folder_members(folder_id, member_id, access, link_hash) VALUES($1, $2, $3, $4)
       ON CONFLICT (folder_id, member_id) DO UPDATE SET access = EXCLUDED.access, link_hash = EXCLUDED.link_hash`,
      [folderId, memberId, access, linkHash]
    );
  }

  async deleteMember(folderId: string, memberId: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM folder_members WHERE folder_id = $1 AND member_id = $2", [folderId, memberId]);
    return (result.rowCount ?? 0) > 0;
  }

  // --- housekeeping ---

  /** Counts a request in the current one-minute window and returns the total. */
  async hit(key: string): Promise<number> {
    const { rows } = await this.pool.query(
      `INSERT INTO library_rate_limits(key, window_start, count)
       VALUES($1, date_trunc('minute', now()), 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN library_rate_limits.window_start = date_trunc('minute', now())
                      THEN library_rate_limits.count + 1 ELSE 1 END,
         window_start = date_trunc('minute', now())
       RETURNING count`,
      [key]
    );
    return rows[0].count;
  }

  async cleanup(): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE expires_at <= now()");
    await this.pool.query("DELETE FROM webauthn_challenges WHERE expires_at <= now()");
    await this.pool.query("DELETE FROM library_rate_limits WHERE window_start < now() - interval '1 hour'");
    await this.pool.query("DELETE FROM folder_links WHERE expires_at < now() - interval '30 days'");
    await this.pool.query("DELETE FROM saved_items WHERE deleted_at < now() - interval '30 days'");
  }
}
