import { Pool, QueryResultRow } from "pg";
import { Share } from "../domain/share";

/** Data-access contract for shares — the service depends on this, not on pg.
 * Shares are immutable once created; there is intentionally no update/mutate
 * method, so reading a share never changes stored state. */
export interface ShareRepository {
  create(id: string, content: string): Promise<Share>;
  findById(id: string): Promise<Share | null>;
}

/** Raw row shape as returned by Postgres (snake_case columns). */
interface ShareRow extends QueryResultRow {
  id: string;
  content: string;
  created_at: Date;
  view_count: number;
}

function toShare(row: ShareRow): Share {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    viewCount: row.view_count,
  };
}

const SELECT_COLUMNS = "id, content, created_at, view_count";

export class PgShareRepository implements ShareRepository {
  constructor(private readonly pool: Pool) {}

  async create(id: string, content: string): Promise<Share> {
    const { rows } = await this.pool.query<ShareRow>(
      `INSERT INTO shares (id, content)
       VALUES ($1, $2)
       RETURNING ${SELECT_COLUMNS}`,
      [id, content]
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
}
