import { CreateShareInput, CreateShareResult, Share, ShareSummary } from "../domain/share";
import { ShareRepository } from "../repositories/shareRepository";
import { NotFoundError, ValidationError } from "../errors";
import { generateId } from "./idGenerator";
import { sharePreview } from "./sharePreview";

/** Expiry choices offered in "my links"; null removes the expiry. */
const EXPIRY_DAYS = [1, 7, 30];

/** Business logic for shares: validation, id generation, view counting,
 * and the owner's list / expiry / delete. */
export class ShareService {
  constructor(
    private readonly repository: ShareRepository,
    private readonly maxContentLength: number
  ) {}

  async createShare(input: CreateShareInput, ownerId: string | null): Promise<CreateShareResult> {
    const content = this.validateContent(input.content);
    const id = generateId();
    await this.repository.create(id, content, ownerId);
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

  async setExpiry(ownerId: string, id: string, expiresInDays: unknown): Promise<ShareSummary> {
    if (expiresInDays !== null && !EXPIRY_DAYS.includes(expiresInDays as number)) {
      throw new ValidationError("`expiresInDays` must be null, 1, 7 or 30");
    }
    const expiresAt = expiresInDays === null ? null : new Date(Date.now() + (expiresInDays as number) * 86_400_000);
    const share = await this.repository.setExpiry(id, ownerId, expiresAt);
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
