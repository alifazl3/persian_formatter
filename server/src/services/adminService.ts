import { AdminRepository } from "../repositories/adminRepository";
import { ShareSort, ShareStatus, UserKind, UserSort } from "../domain/admin";
import { NotFoundError, ValidationError } from "../errors";
import { sharePreview } from "./sharePreview";

const RANGES = [7, 30, 90];
const PAGE_SIZE = 20;
const MAX_QUERY = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Picks `value` when it is one of `allowed`, else the first (the default). */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  return allowed.includes(value as T) ? (value as T) : allowed[0]!;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_QUERY) : "";
}

function page(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
}

const title = (content: string) => sharePreview(content).title || "بدون عنوان";

/** The admin dashboard: who may use it, and what it shows. */
export class AdminService {
  constructor(
    private readonly repository: AdminRepository,
    private readonly adminEmails: readonly string[]
  ) {}

  isAdmin(email: string | null | undefined): boolean {
    return !!email && this.adminEmails.includes(email.toLowerCase());
  }

  async overview(days: unknown) {
    const range = RANGES.includes(Number(days)) ? Number(days) : 30;
    const [totals, daily, top, newest] = await Promise.all([
      this.repository.totals(range),
      this.repository.daily(range),
      this.repository.shares("all", "", null, "views", 5, 0),
      this.repository.users("account", "", "newest", 5, 0),
    ]);
    return {
      days: range, totals, daily, admins: this.adminEmails,
      topShares: top.items.map(share => this.share(share)), newUsers: newest.items,
    };
  }

  async users(params: Record<string, unknown>) {
    const kind = oneOf<UserKind>(params.kind, ["account", "guest", "all"]);
    const sort = oneOf<UserSort>(params.sort, ["newest", "documents", "shares", "views"]);
    const query = text(params.q);
    const current = page(params.page);
    const [list, counts] = await Promise.all([
      this.repository.users(kind, query, sort, PAGE_SIZE, (current - 1) * PAGE_SIZE),
      this.repository.userCounts(query),
    ]);
    return { users: list.items, total: list.total, counts, page: current, pageSize: PAGE_SIZE };
  }

  async shares(params: Record<string, unknown>) {
    const status = oneOf<ShareStatus>(params.status, ["all", "live", "expiring", "expired", "reported"]);
    const sort = oneOf<ShareSort>(params.sort, ["newest", "views", "reports"]);
    const query = text(params.q);
    const owner = typeof params.owner === "string" && UUID.test(params.owner) ? params.owner : null;
    const current = page(params.page);
    const [list, counts] = await Promise.all([
      this.repository.shares(status, query, owner, sort, PAGE_SIZE, (current - 1) * PAGE_SIZE),
      this.repository.shareCounts(query, owner),
    ]);
    return { shares: list.items.map(share => this.share(share)), total: list.total, counts, page: current, pageSize: PAGE_SIZE };
  }

  async reports(status: unknown) {
    const reports = await this.repository.reports(status !== "all", 100);
    return reports.map(({ content, ...report }) => ({ ...report, title: title(content) }));
  }

  async resolveReport(id: unknown): Promise<void> {
    const n = Number(id);
    if (!Number.isInteger(n) || n < 1) throw new ValidationError("Invalid report id");
    if (!(await this.repository.resolveReport(n))) throw new NotFoundError("Report not found");
  }

  async deleteShare(id: string): Promise<void> {
    if (!(await this.repository.deleteShare(id))) throw new NotFoundError("Share not found");
  }

  private share<T extends { content: string }>({ content, ...share }: T) {
    return { ...share, title: title(content) };
  }
}
