import { CreateShareInput, CreateShareResult, Share, ShareSummary } from "../domain/share";
import { ShareRepository } from "../repositories/shareRepository";
import { NotFoundError, ValidationError } from "../errors";
import { generateId } from "./idGenerator";
import { sharePreview } from "./sharePreview";

/** Expiry choices offered in "my links"; null removes the expiry. */
const EXPIRY_DAYS = [1, 7, 30];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Changes the owner can make to a link from "my links". */
export interface ShareChanges {
  readonly expiresInDays?: unknown;
  readonly live?: unknown;
}

/** Business logic for shares: validation, id generation, view counting,
 * and the owner's list / expiry / delete. */
export class ShareService {
  constructor(
    private readonly repository: ShareRepository,
    private readonly maxContentLength: number
  ) {}

  async createShare(input: CreateShareInput, ownerId: string | null): Promise<CreateShareResult> {
    const content = this.validateContent(input.content);
    // Remember the saved document the text came from, so the link can later be
    // made live — but only one the creator can actually read.
    const documentId = typeof input.documentId === "string" && UUID.test(input.documentId) && ownerId
      && await this.repository.canReadDocument(input.documentId, ownerId) ? input.documentId : null;
    const id = generateId();
    await this.repository.create(id, content, ownerId, documentId);
    return { id };
  }

  /** Opens a link: expired links read as missing. A view by anyone but the
   * owner is counted; the shared content itself is never changed. */
  async getShare(id: string, viewerId: string | null): Promise<Share> {
    const share = await this.findActive(id);
    if (!share) {
      throw new NotFoundError("Share not found");
    }
    if (!share.ownerId || share.ownerId !== viewerId) {
      await this.repository.recordView(id);
    }
    return share;
  }

  /** Same as getShare but without counting a view (link-preview crawlers). */
  async findActive(id: string): Promise<Share | null> {
    const share = await this.repository.findById(id);
    return share && (!share.expiresAt || share.expiresAt > new Date()) ? share : null;
  }

  async listShares(ownerId: string): Promise<ShareSummary[]> {
    const shares = await this.repository.listByOwner(ownerId);
    return shares.map(share => this.summary(share));
  }

  async updateShare(ownerId: string, id: string, changes: ShareChanges): Promise<ShareSummary> {
    const update: { expiresAt?: Date | null; live?: boolean } = {};
    if (changes.expiresInDays !== undefined) {
      const days = changes.expiresInDays;
      if (days !== null && !EXPIRY_DAYS.includes(days as number)) {
        throw new ValidationError("`expiresInDays` must be null, 1, 7 or 30");
      }
      update.expiresAt = days === null ? null : new Date(Date.now() + (days as number) * 86_400_000);
    }
    if (changes.live !== undefined) {
      if (typeof changes.live !== "boolean") {
        throw new ValidationError("`live` must be a boolean");
      }
      update.live = changes.live;
    }
    const current = await this.repository.findById(id);
    if (!current || current.ownerId !== ownerId) {
      throw new NotFoundError("Share not found");
    }
    if (update.live && !(current.documentId && await this.repository.canReadDocument(current.documentId, ownerId))) {
      throw new ValidationError("This link is not linked to a saved text you can read");
    }
    const share = await this.repository.update(id, ownerId, update);
    if (!share) {
      throw new NotFoundError("Share not found");
    }
    return this.summary(share);
  }

  async deleteShare(ownerId: string, id: string): Promise<void> {
    if (!(await this.repository.delete(id, ownerId))) {
      throw new NotFoundError("Share not found");
    }
  }

  private summary(share: Share): ShareSummary {
    return {
      id: share.id,
      title: sharePreview(share.content).title,
      createdAt: share.createdAt,
      viewCount: share.viewCount,
      expiresAt: share.expiresAt,
      documentId: share.documentId,
      live: share.live,
    };
  }

  private validateContent(content: unknown): string {
    if (typeof content !== "string") {
      throw new ValidationError("`content` must be a string");
    }
    if (content.trim().length === 0) {
      throw new ValidationError("`content` must not be empty");
    }
    if (content.length > this.maxContentLength) {
      throw new ValidationError(
        `\`content\` must be at most ${this.maxContentLength} characters`
      );
    }
    return content;
  }
}
