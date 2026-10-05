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
    ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE folders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE folder_links ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';
    ALTER TABLE folder_links ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    ALTER TABLE folder_links ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
    ALTER TABLE folder_links DROP CONSTRAINT IF EXISTS folder_links_access_check;
    ALTER TABLE folder_links ADD CONSTRAINT folder_links_access_check CHECK (access IN ('read', 'edit', 'full'));
    CREATE INDEX IF NOT EXISTS folder_links_folder_idx ON folder_links(folder_id);
    -- Joining a shared folder makes the visitor (guest or account) a member.
    -- Access follows the account, not a browser session, and lasts until the
    -- owner removes the member or revokes the link they joined through.
    CREATE TABLE IF NOT EXISTS folder_members (
      folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      member_id UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      access TEXT NOT NULL CHECK (access IN ('read', 'edit', 'full')),
      link_hash TEXT REFERENCES folder_links(token_hash) ON DELETE SET NULL,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (folder_id, member_id)
    );
    CREATE INDEX IF NOT EXISTS folder_members_member_idx ON folder_members(member_id);
    CREATE INDEX IF NOT EXISTS folder_members_link_idx ON folder_members(link_hash);
    -- Session-bound grants from the previous sharing model become memberships.
    DO $$ BEGIN
      IF to_regclass('folder_grants') IS NOT NULL THEN
        INSERT INTO folder_members(folder_id, member_id, access, link_hash)
          SELECT DISTINCT ON (g.folder_id, s.owner_id) g.folder_id, s.owner_id, g.access, g.link_hash
          FROM folder_grants g
          JOIN sessions s ON s.token_hash = g.session_hash
          JOIN folders f ON f.id = g.folder_id
          WHERE g.expires_at > now() AND s.expires_at > now() AND s.owner_id <> f.owner_id
          ORDER BY g.folder_id, s.owner_id, g.expires_at DESC
          ON CONFLICT DO NOTHING;
        DROP TABLE folder_grants;
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS library_rate_limits (
      key TEXT PRIMARY KEY,
      window_start TIMESTAMPTZ NOT NULL,
      count INTEGER NOT NULL
    );
  `);
}
