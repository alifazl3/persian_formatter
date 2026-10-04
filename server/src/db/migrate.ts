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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS owners (
      id UUID PRIMARY KEY,
      email TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id TEXT PRIMARY KEY,
      owner_id UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      public_key JSONB NOT NULL,
      sign_count BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      owner_id UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_owner_idx ON sessions(owner_id);
    CREATE TABLE IF NOT EXISTS webauthn_challenges (
      token_hash TEXT PRIMARY KEY,
      challenge TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
      email TEXT NOT NULL,
      owner_id UUID REFERENCES owners(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS folders (
      id UUID PRIMARY KEY,
      owner_id UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS folders_owner_idx ON folders(owner_id);
    CREATE TABLE IF NOT EXISTS saved_items (
      id UUID PRIMARY KEY,
      owner_id UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS saved_items_owner_idx ON saved_items(owner_id);
    CREATE INDEX IF NOT EXISTS saved_items_folder_idx ON saved_items(folder_id);
    CREATE TABLE IF NOT EXISTS folder_links (
      token_hash TEXT PRIMARY KEY,
      folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      access TEXT NOT NULL CHECK (access IN ('read', 'full')),
      max_uses INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS folder_grants (
      token_hash TEXT PRIMARY KEY,
      link_hash TEXT NOT NULL REFERENCES folder_links(token_hash) ON DELETE CASCADE,
      folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      access TEXT NOT NULL CHECK (access IN ('read', 'full')),
      expires_at TIMESTAMPTZ NOT NULL
    );
    ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE folder_links ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';
    ALTER TABLE folder_links ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    ALTER TABLE folder_links ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
    ALTER TABLE folder_grants ADD COLUMN IF NOT EXISTS session_hash TEXT REFERENCES sessions(token_hash) ON DELETE CASCADE;
    ALTER TABLE folder_links DROP CONSTRAINT IF EXISTS folder_links_access_check;
    ALTER TABLE folder_links ADD CONSTRAINT folder_links_access_check CHECK (access IN ('read', 'edit', 'full'));
    ALTER TABLE folder_grants DROP CONSTRAINT IF EXISTS folder_grants_access_check;
    ALTER TABLE folder_grants ADD CONSTRAINT folder_grants_access_check CHECK (access IN ('read', 'edit', 'full'));
    CREATE UNIQUE INDEX IF NOT EXISTS folder_grants_link_session_idx ON folder_grants(link_hash,session_hash);
    CREATE INDEX IF NOT EXISTS folder_links_folder_idx ON folder_links(folder_id);
    CREATE INDEX IF NOT EXISTS folder_grants_expiry_idx ON folder_grants(expires_at);
    CREATE INDEX IF NOT EXISTS folder_grants_session_idx ON folder_grants(session_hash);
    CREATE TABLE IF NOT EXISTS library_rate_limits (
      key TEXT PRIMARY KEY,
      window_start TIMESTAMPTZ NOT NULL,
      count INTEGER NOT NULL
    );
  `);
}
