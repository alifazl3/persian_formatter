import { Report } from "../domain/report";
import { ReportRepository } from "../repositories/reportRepository";
import { ShareRepository } from "../repositories/shareRepository";
import { NotFoundError, ValidationError } from "../errors";

const MAX_NOTE_LENGTH = 2000;
const LIST_LIMIT = 200;

/** Business logic for viewer problem reports on shared pages. */
export class ReportService {
  constructor(
    private readonly reports: ReportRepository,
    private readonly shares: ShareRepository
  ) {}

  async createReport(shareId: string, note: unknown): Promise<Report> {
    const cleanNote = this.validateNote(note);

    // Only existing shares can be reported (also gives the FK a clean 404
    // instead of a 500 on a bogus id).
    const share = await this.shares.findById(shareId);
    if (!share) {
      throw new NotFoundError("Share not found");
    }

    return this.reports.create(shareId, cleanNote);
  }

  async listReports(): Promise<Report[]> {
    return this.reports.listAll(LIST_LIMIT);
  }

  /** The note is optional free text; absent/empty is fine. */
  private validateNote(note: unknown): string {
    if (note === undefined || note === null) return "";
    if (typeof note !== "string") {
      throw new ValidationError("`note` must be a string");
    }
    const trimmed = note.trim();
    if (trimmed.length > MAX_NOTE_LENGTH) {
      throw new ValidationError(
        `\`note\` must be at most ${MAX_NOTE_LENGTH} characters`
      );
    }
    return trimmed;
  }
}
