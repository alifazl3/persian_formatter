/** Read models for the admin dashboard. */

export interface AdminTotals {
  readonly accounts: number;
  readonly newAccounts: number;
  readonly activeGuests: number;
  readonly documents: number;
  readonly newDocuments: number;
  readonly sharedFolders: number;
  readonly folderMembers: number;
  readonly shares: number;
  readonly newShares: number;
  readonly liveShares: number;
  readonly views: number;
  readonly openReports: number;
}

/** Activity on one day (Tehran time). */
export interface AdminDay {
  readonly day: string;
  readonly documents: number;
  readonly shares: number;
  readonly accounts: number;
}

export interface AdminUser {
  readonly id: string;
  readonly email: string | null;
  readonly joinedAt: Date;
  readonly documents: number;
  readonly folders: number;
  readonly memberships: number;
  readonly shares: number;
  readonly views: number;
}

export interface AdminShare {
  readonly id: string;
  /** The start of the stored text, enough to derive a title. */
  readonly content: string;
  readonly ownerId: string | null;
  readonly ownerEmail: string | null;
  readonly live: boolean;
  readonly viewCount: number;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly openReports: number;
}

export interface AdminReport {
  readonly id: number;
  readonly shareId: string;
  readonly content: string;
  readonly note: string;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

export type UserKind = "account" | "guest" | "all";
export type UserSort = "newest" | "documents" | "shares" | "views";
export type ShareStatus = "all" | "live" | "expiring" | "expired" | "reported";
export type ShareSort = "newest" | "views" | "reports";

/** One page of a list plus the size of the whole filtered list. */
export interface Page<T> {
  readonly items: T[];
  readonly total: number;
}
