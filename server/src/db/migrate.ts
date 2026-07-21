import { Pool } from "pg";

/** Idempotent schema setup, run on startup. */
export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shares (
      id          TEXT        PRIMARY KEY,
      content     TEXT        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      view_count  INTEGER     NOT NULL DEFAULT 0
    );
  `);

  // Problem reports filed by viewers of a shared page (optional note).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id          BIGSERIAL   PRIMARY KEY,
      share_id    TEXT        NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
      note        TEXT        NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
