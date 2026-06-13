/** A stored, shareable document. */
export interface Share {
  readonly id: string;
  readonly content: string;
  readonly createdAt: Date;
  readonly viewCount: number;
}

/** Input accepted by the service when creating a share. */
export interface CreateShareInput {
  readonly content: unknown;
}

/** Result returned to the caller after a share is created. */
export interface CreateShareResult {
  readonly id: string;
}
