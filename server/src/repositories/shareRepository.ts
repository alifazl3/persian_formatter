import { Pool, QueryResultRow } from "pg";
import { Share } from "../domain/share";

/** Data-access contract for shares — the service depends on this, not on pg.
 * A share's content never changes once created; only its owner's settings
 * (expiry), its view counter and its existence (delete) do. */
export interface ShareRepository {
  create(id: string, content: string, ownerId: string | null): Promise<Share>;
  findById(id: string): Promise<Share | null>;
  recordView(id: string): Promise<void>;
  listByOwner(ownerId: string): Promise<Share[]>;
  setExpiry(id: string, ownerId: string, expiresAt: Date | null): Promise<Share | null>;
  delete(id: string, ownerId: string): Promise<boolean>;
}

/** Raw row shape as returned by Postgres (snake_case columns). */
interface ShareRow extends QueryResultRow {
  id: string;
  content: string;
  created_at: Date;
  view_count: number;
  owner_id: string | null;
  expires_at: Date | null;
}

function toShare(row: ShareRow): Share {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    viewCount: row.view_count,
    ownerId: row.owner_id,
    expiresAt: row.expires_at,
  };
}

const SELECT_COLUMNS = "id, content, created_at, view_count, owner_id, expires_at";

export class PgShareRepository implements ShareRepository {
  constructor(private readonly pool: Pool) {}

  async create(id: string, content: string, ownerId: string | null): Promise<Share> {
    const { rows } = await this.pool.query<ShareRow>(
      `INSERT INTO shares (id, content, owner_id)
       VALUES ($1, $2, $3)
       RETURNING ${SELECT_COLUMNS}`,
      [id, content, ownerId]
    );
    const row = rows[0];
    if (!row) {
      throw new Error("INSERT ... RETURNING returned no row");
    }
    return toShare(row);
  }

  async findById(id: string): Promise<Share | null> {
    const { rows } = await this.pool.query<ShareRow>(
      `SELECT ${SELECT_COLUMNS} FROM shares WHERE id = $1`,
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
      `SELECT id, left(content, 2000) AS content, created_at, view_count, owner_id, expires_at
       FROM shares WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [ownerId]
    );
    return rows.map(toShare);
  }

  async setExpiry(id: string, ownerId: string, expiresAt: Date | null): Promise<Share | null> {
    const { rows } = await this.pool.query<ShareRow>(
      `UPDATE shares SET expires_at = $3 WHERE id = $1 AND owner_id = $2
       RETURNING ${SELECT_COLUMNS}`,
      [id, ownerId, expiresAt]
    );
    const row = rows[0];
    return row ? toShare(row) : null;
  }

  async delete(id: string, ownerId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("DELETE FROM shares WHERE id = $1 AND owner_id = $2", [id, ownerId]);
    return (rowCount ?? 0) > 0;
  }
}
