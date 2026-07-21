import { Pool, QueryResultRow } from "pg";
import { Report } from "../domain/report";

/** Data-access contract for problem reports. */
export interface ReportRepository {
  create(shareId: string, note: string): Promise<Report>;
  listAll(limit: number): Promise<Report[]>;
}

/** Raw row shape as returned by Postgres (snake_case columns). */
interface ReportRow extends QueryResultRow {
  id: string; // BIGSERIAL comes back as a string
  share_id: string;
  note: string;
  created_at: Date;
}

function toReport(row: ReportRow): Report {
  return {
    id: Number(row.id),
    shareId: row.share_id,
    note: row.note,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = "id, share_id, note, created_at";

export class PgReportRepository implements ReportRepository {
  constructor(private readonly pool: Pool) {}

  async create(shareId: string, note: string): Promise<Report> {
    const { rows } = await this.pool.query<ReportRow>(
      `INSERT INTO reports (share_id, note)
       VALUES ($1, $2)
       RETURNING ${SELECT_COLUMNS}`,
      [shareId, note]
    );
    const row = rows[0];
    if (!row) {
      throw new Error("INSERT ... RETURNING returned no row");
    }
    return toReport(row);
  }

  async listAll(limit: number): Promise<Report[]> {
    const { rows } = await this.pool.query<ReportRow>(
      `SELECT ${SELECT_COLUMNS} FROM reports ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows.map(toReport);
  }
}
