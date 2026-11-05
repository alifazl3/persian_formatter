import { Pool, QueryResultRow } from "pg";
import { Share } from "../domain/share";

/** Data-access contract for shares — the service depends on this, not on pg.
 * A share's snapshot never changes once created; only its owner's settings
 * (expiry, live), its view counter and its existence (delete) do. */
export interface ShareRepository {
  create(id: string, content: string, ownerId: string | null, documentId: string | null): Promise<Share>;
  findById(id: string): Promise<Share | null>;
  recordView(id: string): Promise<void>;
  listByOwner(ownerId: string): Promise<Share[]>;
  update(id: string, ownerId: string, changes: { expiresAt?: Date | null; live?: boolean }): Promise<Share | null>;
  delete(id: string, ownerId: string): Promise<boolean>;
  /** Whether the user may read the saved document (own, or in a folder they own or belong to). */
  canReadDocument(documentId: string, userId: string): Promise<boolean>;
}

/** Raw row shape as returned by Postgres (snake_case columns). */
interface ShareRow extends QueryResultRow {
  id: string;
  content: string;
  created_at: Date;
  view_count: number;
  owner_id: string | null;
  expires_at: Date | null;
  document_id: string | null;
  live: boolean;
}

function toShare(row: ShareRow): Share {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    viewCount: row.view_count,
    ownerId: row.owner_id,
    expiresAt: row.expires_at,
    documentId: row.document_id,
    live: row.live,
  };
}

/** `$user` may read saved document `d`: its owner, or the owner or a member of its folder. */
const readable = (user: string) => `(d.owner_id = ${user} OR EXISTS (
  SELECT 1 FROM folders f LEFT JOIN folder_members m ON m.folder_id = f.id AND m.member_id = ${user}
  WHERE f.id = d.folder_id AND (f.owner_id = ${user} OR m.member_id IS NOT NULL)))`;

/** A live link reads the document's current text while the document exists
 * and its creator can still read it; otherwise the snapshot is shown. */
const FROM_SHARES = `shares s LEFT JOIN saved_items d
  ON s.live AND d.id = s.document_id AND d.deleted_at IS NULL AND ${readable("s.owner_id")}`;
const columns = (content: string) =>
  `s.id, ${content} AS content, s.created_at, s.view_count, s.owner_id, s.expires_at, s.document_id, s.live`;
const SELECT_COLUMNS = columns("COALESCE(d.content, s.content)");

export class PgShareRepository implements ShareRepository {
  constructor(private readonly pool: Pool) {}

  async create(id: string, content: string, ownerId: string | null, documentId: string | null): Promise<Share> {
    await this.pool.query(
      `INSERT INTO shares (id, content, owner_id, document_id) VALUES ($1, $2, $3, $4)`,
      [id, content, ownerId, documentId]
    );
    const share = await this.findById(id);
    if (!share) {
      throw new Error("INSERT returned no row");
    }
    return share;
  }

  async findById(id: string): Promise<Share | null> {
    const { rows } = await this.pool.query<ShareRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${FROM_SHARES} WHERE s.id = $1`,
      [id]
    );
    const row = rows[0];
    return row ? toShare(row) : null;
  }

  async recordView(id: string): Promise<void> {
    await this.pool.query("UPDATE shares SET view_count = view_count + 1 WHERE id = $1", [id]);
  }

  async listByOwner(ownerId: string): Promise<Share[]> {
    // Only the start of the body is needed to derive a title for the list.
    const { rows } = await this.pool.query<ShareRow>(
      `SELECT ${columns("left(COALESCE(d.content, s.content), 2000)")}
       FROM ${FROM_SHARES} WHERE s.owner_id = $1 ORDER BY s.created_at DESC LIMIT 200`,
      [ownerId]
    );
    return rows.map(toShare);
  }

  async update(id: string, ownerId: string, changes: { expiresAt?: Date | null; live?: boolean }): Promise<Share | null> {
    const { rowCount } = await this.pool.query(
      `UPDATE shares SET
         expires_at = CASE WHEN $3 THEN $4::timestamptz ELSE expires_at END,
         live = COALESCE($5, live)
       WHERE id = $1 AND owner_id = $2`,
      [id, ownerId, "expiresAt" in changes, changes.expiresAt ?? null, changes.live ?? null]
    );
    return rowCount ? this.findById(id) : null;
  }

  async delete(id: string, ownerId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("DELETE FROM shares WHERE id = $1 AND owner_id = $2", [id, ownerId]);
    return (rowCount ?? 0) > 0;
  }

  async canReadDocument(documentId: string, userId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM saved_items d WHERE d.id = $1 AND d.deleted_at IS NULL AND ${readable("$2")}`,
      [documentId, userId]
    );
    return rows.length > 0;
  }
}
