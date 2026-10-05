/** Access a shared-folder member has. `full` also manages (renames/deletes) the folder. */
export type Access = "read" | "edit" | "full";

/** What the current user is to a folder: its owner, or a member with some access. */
export type Role = "owner" | Access;

export const ACCESS_LEVELS: readonly Access[] = ["read", "edit", "full"];

const RANK: Record<Role, number> = { read: 1, edit: 2, full: 3, owner: 4 };
export const rank = (role: Role): number => RANK[role];
export const canEditDocuments = (role: Role): boolean => rank(role) >= RANK.edit;
export const canManageFolder = (role: Role): boolean => rank(role) >= RANK.full;

export interface FolderSummary {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly documentCount: number;
  /** Members the folder is shared with; only reported to the owner. */
  readonly memberCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A saved document without its body, as listed in the library. */
export interface DocumentSummary {
  readonly id: string;
  readonly folderId: string | null;
  readonly title: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Document extends DocumentSummary {
  readonly content: string;
  /** The current user's role for this document. */
  readonly role: Role;
}

export interface Library {
  readonly folders: FolderSummary[];
  readonly documents: DocumentSummary[];
}

export interface FolderLink {
  /** Hash of the link token; the raw token is only returned once, on creation. */
  readonly id: string;
  readonly label: string;
  readonly access: Access;
  readonly singleUse: boolean;
  readonly useCount: number;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
}

export interface CreatedFolderLink extends FolderLink {
  readonly token: string;
}

export interface FolderMember {
  readonly id: string;
  readonly access: Access;
  /** Whether the member has an account (email + passkey) or is a guest. */
  readonly registered: boolean;
  /** Label of the link they joined through, or null if it was removed. */
  readonly linkLabel: string | null;
  readonly joinedAt: Date;
}

export interface LinkPreview {
  readonly folderId: string;
  readonly name: string;
  readonly access: Access;
  readonly singleUse: boolean;
  readonly expiresAt: Date | null;
  /** The visitor's current role, if they already own or joined the folder. */
  readonly role: Role | null;
}

export interface JoinResult {
  readonly folderId: string;
  readonly role: Role;
}
