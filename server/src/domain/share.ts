/** A stored, shareable document. */
export interface Share {
  readonly id: string;
  readonly content: string;
  readonly createdAt: Date;
  readonly viewCount: number;
  /** Who created the link; null for links made before shares had owners. */
  readonly ownerId: string | null;
  /** After this moment the link stops opening; null means it never expires. */
  readonly expiresAt: Date | null;
}

/** Input accepted by the service when creating a share. */
export interface CreateShareInput {
  readonly content: unknown;
}

/** Result returned to the caller after a share is created. */
export interface CreateShareResult {
  readonly id: string;
}

/** One row of the owner's "my links" list (no body, just enough to recognise it). */
export interface ShareSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: Date;
  readonly viewCount: number;
  readonly expiresAt: Date | null;
}
