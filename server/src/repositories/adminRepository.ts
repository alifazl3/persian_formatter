import { Pool } from "pg";
import {
  AdminDay, AdminReport, AdminShare, AdminTotals, AdminUser, Page,
  ShareSort, ShareStatus, UserKind, UserSort,
} from "../domain/admin";

/** Read-mostly queries behind the admin dashboard. */
export interface AdminRepository {
  totals(days: number): Promise<AdminTotals>;
  daily(days: number): Promise<AdminDay[]>;
  users(kind: UserKind, query: string, sort: UserSort, limit: number, offset: number): Promise<Page<AdminUser>>;
  userCounts(query: string): Promise<Record<UserKind, number>>;
  shares(status: ShareStatus, query: string, ownerId: string | null, sort: ShareSort, limit: number, offset: number): Promise<Page<AdminShare>>;
  shareCounts(query: string, ownerId: string | null): Promise<Record<ShareStatus, number>>;
  reports(openOnly: boolean, limit: number): Promise<AdminReport[]>;
  resolveReport(id: number): Promise<boolean>;
  deleteShare(id: string): Promise<boolean>;
}

/** Days are counted in Tehran time, where the app's users are. */
const TZ = "Asia/Tehran";

/** An account's join date: its first passkey (the owner row may be an older guest). */
const JOINED = `COALESCE((SELECT min(c.created_at) FROM webauthn_credentials c WHERE c.owner_id = o.id), o.created_at)`;

/** Guests are only listed once they keep something; every first visit creates one. */
const USER_STATS = `
  SELECT o.id, o.email, ${JOINED} AS joined_at,
    (SELECT count(*) FROM saved_items i WHERE i.owner_id = o.id AND i.deleted_at IS NULL)::int AS documents,
    (SELECT count(*) FROM folders f WHERE f.owner_id = o.id)::int AS folders,
    (SELECT count(*) FROM folder_members m WHERE m.member_id = o.id)::int AS memberships,
    (SELECT count(*) FROM shares s WHERE s.owner_id = o.id)::int AS shares,
    (SELECT COALESCE(sum(s.view_count), 0) FROM shares s WHERE s.owner_id = o.id)::int AS views
  FROM owners o
  WHERE ($1 = '' OR o.email ILIKE '%' || $1 || '%')`;
const KEPT_SOMETHING = "(documents + folders + memberships + shares) > 0";
const USER_KIND: Record<UserKind, string> = {
  all: `(email IS NOT NULL OR ${KEPT_SOMETHING})`,
  account: "email IS NOT NULL",
  guest: `email IS NULL AND ${KEPT_SOMETHING}`,
};
const USER_ORDER: Record<UserSort, string> = {
  newest: "joined_at DESC",
  documents: "documents DESC, joined_at DESC",
  shares: "shares DESC, joined_at DESC",
  views: "views DESC, joined_at DESC",
};

const SHARE_ROWS = `
  SELECT s.id, left(s.content, 2000) AS content, s.owner_id, o.email AS owner_email, s.live,
    s.view_count, s.created_at, s.expires_at,
    (SELECT count(*) FROM reports r WHERE r.share_id = s.id AND r.resolved_at IS NULL)::int AS open_reports
  FROM shares s LEFT JOIN owners o ON o.id = s.owner_id
  WHERE ($1 = '' OR s.content ILIKE '%' || $1 || '%' OR o.email ILIKE '%' || $1 || '%')
    AND ($2::uuid IS NULL OR s.owner_id = $2::uuid)`;
const SHARE_STATUS: Record<ShareStatus, string> = {
  all: "true",
  live: "live",
  expiring: "expires_at > now()",
  expired: "expires_at <= now()",
  reported: "open_reports > 0",
};
const SHARE_ORDER: Record<ShareSort, string> = {
  newest: "created_at DESC",
  views: "view_count DESC, created_at DESC",
  reports: "open_reports DESC, created_at DESC",
};

const int = (value: unknown) => Number(value ?? 0);

export class PgAdminRepository implements AdminRepository {
  constructor(private readonly pool: Pool) {}

  async totals(days: number): Promise<AdminTotals> {
    const since = `now() - make_interval(days => $1::int)`;
    const { rows } = await this.pool.query(
      `SELECT
        (SELECT count(*) FROM owners WHERE email IS NOT NULL) AS accounts,
        (SELECT count(*) FROM owners o WHERE o.email IS NOT NULL AND ${JOINED} >= ${since}) AS new_accounts,
        (SELECT count(DISTINCT o.id) FROM owners o JOIN sessions s ON s.owner_id = o.id
          WHERE o.email IS NULL AND s.expires_at > now()) AS active_guests,
        (SELECT count(*) FROM saved_items WHERE deleted_at IS NULL) AS documents,
        (SELECT count(*) FROM saved_items WHERE deleted_at IS NULL AND created_at >= ${since}) AS new_documents,
        (SELECT count(DISTINCT folder_id) FROM folder_members) AS shared_folders,
        (SELECT count(*) FROM folder_members) AS folder_members,
        (SELECT count(*) FROM shares) AS shares,
        (SELECT count(*) FROM shares WHERE created_at >= ${since}) AS new_shares,
        (SELECT count(*) FROM shares WHERE live) AS live_shares,
        (SELECT COALESCE(sum(view_count), 0) FROM shares) AS views,
        (SELECT count(*) FROM reports WHERE resolved_at IS NULL) AS open_reports`,
      [days]
    );
    const row = rows[0];
    return {
      accounts: int(row.accounts), newAccounts: int(row.new_accounts), activeGuests: int(row.active_guests),
      documents: int(row.documents), newDocuments: int(row.new_documents),
      sharedFolders: int(row.shared_folders), folderMembers: int(row.folder_members),
      shares: int(row.shares), newShares: int(row.new_shares), liveShares: int(row.live_shares),
      views: int(row.views), openReports: int(row.open_reports),
    };
  }

  async daily(days: number): Promise<AdminDay[]> {
    const local = (column: string) => `(${column} AT TIME ZONE '${TZ}')::date`;
    const { rows } = await this.pool.query(
      `WITH span AS (
         SELECT generate_series(${local("now()")} - ($1::int - 1), ${local("now()")}, interval '1 day')::date AS day
       )
       SELECT to_char(span.day, 'YYYY-MM-DD') AS day,
         (SELECT count(*) FROM saved_items i WHERE ${local("i.created_at")} = span.day) AS documents,
         (SELECT count(*) FROM shares s WHERE ${local("s.created_at")} = span.day) AS shares,
         (SELECT count(*) FROM owners o WHERE o.email IS NOT NULL
            AND (SELECT ${local("min(c.created_at)")} FROM webauthn_credentials c WHERE c.owner_id = o.id) = span.day) AS accounts
       FROM span ORDER BY span.day`,
      [days]
    );
    return rows.map(row => ({ day: row.day, documents: int(row.documents), shares: int(row.shares), accounts: int(row.accounts) }));
  }

  async users(kind: UserKind, query: string, sort: UserSort, limit: number, offset: number): Promise<Page<AdminUser>> {
    const { rows } = await this.pool.query(
      `SELECT *, count(*) OVER () AS total FROM (${USER_STATS}) u
       WHERE ${USER_KIND[kind]} ORDER BY ${USER_ORDER[sort]} LIMIT $2 OFFSET $3`,
      [query, limit, offset]
    );
    return {
      total: int(rows[0]?.total),
      items: rows.map(row => ({
        id: row.id, email: row.email, joinedAt: row.joined_at, documents: row.documents, folders: row.folders,
        memberships: row.memberships, shares: row.shares, views: row.views,
      })),
    };
  }

  async userCounts(query: string): Promise<Record<UserKind, number>> {
    const { rows } = await this.pool.query(
      `SELECT count(*) FILTER (WHERE ${USER_KIND.all}) AS "all", count(*) FILTER (WHERE ${USER_KIND.account}) AS account,
         count(*) FILTER (WHERE ${USER_KIND.guest}) AS guest
       FROM (${USER_STATS}) u`,
      [query]
    );
    return { all: int(rows[0].all), account: int(rows[0].account), guest: int(rows[0].guest) };
  }

  async shares(status: ShareStatus, query: string, ownerId: string | null, sort: ShareSort, limit: number, offset: number): Promise<Page<AdminShare>> {
    const { rows } = await this.pool.query(
      `SELECT *, count(*) OVER () AS total FROM (${SHARE_ROWS}) s
       WHERE ${SHARE_STATUS[status]} ORDER BY ${SHARE_ORDER[sort]} LIMIT $3 OFFSET $4`,
      [query, ownerId, limit, offset]
    );
    return {
      total: int(rows[0]?.total),
      items: rows.map(row => ({
        id: row.id, content: row.content, ownerId: row.owner_id, ownerEmail: row.owner_email, live: row.live,
        viewCount: row.view_count, createdAt: row.created_at, expiresAt: row.expires_at, openReports: row.open_reports,
      })),
    };
  }

  async shareCounts(query: string, ownerId: string | null): Promise<Record<ShareStatus, number>> {
    const { rows } = await this.pool.query(
      `SELECT count(*) AS "all",
         count(*) FILTER (WHERE ${SHARE_STATUS.live}) AS live,
         count(*) FILTER (WHERE ${SHARE_STATUS.expiring}) AS expiring,
         count(*) FILTER (WHERE ${SHARE_STATUS.expired}) AS expired,
         count(*) FILTER (WHERE ${SHARE_STATUS.reported}) AS reported
       FROM (${SHARE_ROWS}) s`,
      [query, ownerId]
    );
    const row = rows[0];
    return { all: int(row.all), live: int(row.live), expiring: int(row.expiring), expired: int(row.expired), reported: int(row.reported) };
  }

  async reports(openOnly: boolean, limit: number): Promise<AdminReport[]> {
    const { rows } = await this.pool.query(
      `SELECT r.id, r.share_id, left(s.content, 2000) AS content, r.note, r.created_at, r.resolved_at
       FROM reports r JOIN shares s ON s.id = r.share_id
       WHERE NOT $1 OR r.resolved_at IS NULL
       ORDER BY r.created_at DESC LIMIT $2`,
      [openOnly, limit]
    );
    return rows.map(row => ({
      id: Number(row.id), shareId: row.share_id, content: row.content, note: row.note,
      createdAt: row.created_at, resolvedAt: row.resolved_at,
    }));
  }

  async resolveReport(id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query("UPDATE reports SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL", [id]);
    return (rowCount ?? 0) > 0;
  }

  async deleteShare(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("DELETE FROM shares WHERE id = $1", [id]);
    return (rowCount ?? 0) > 0;
  }
}
