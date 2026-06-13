import { CreateShareInput, CreateShareResult, Share } from "../domain/share";
import { ShareRepository } from "../repositories/shareRepository";
import { NotFoundError, ValidationError } from "../errors";
import { generateId } from "./idGenerator";

/** Business logic for shares: validation, id generation, view counting. */
export class ShareService {
  constructor(
    private readonly repository: ShareRepository,
    private readonly maxContentLength: number
  ) {}

  async createShare(input: CreateShareInput): Promise<CreateShareResult> {
    const content = this.validateContent(input.content);
    const id = generateId();
    await this.repository.create(id, content);
    return { id };
  }

  async getShare(id: string): Promise<Share> {
    const share = await this.repository.findById(id);
    if (!share) {
      throw new NotFoundError("Share not found");
    }
    // Fire-and-forget would lose errors; await keeps the count consistent.
    await this.repository.incrementViewCount(id);
    return share;
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
