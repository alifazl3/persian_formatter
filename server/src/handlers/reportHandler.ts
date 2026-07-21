import { Request, Response, NextFunction } from "express";
import { ReportService } from "../services/reportService";
import { NotFoundError } from "../errors";

interface CreateReportBody {
  note?: unknown;
}

/** HTTP layer for viewer problem reports. */
export class ReportHandler {
  constructor(
    private readonly service: ReportService,
    /** Empty string disables the admin listing endpoint entirely. */
    private readonly adminToken: string
  ) {}

  create = async (
    req: Request<{ id: string }, unknown, CreateReportBody>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const report = await this.service.createReport(
        req.params.id,
        req.body?.note
      );
      res.status(201).json({ ok: true, id: report.id });
    } catch (err) {
      next(err);
    }
  };

  /** Admin-only listing, guarded by the x-admin-token header. Responds 404
   * (not 401) when disabled or wrong so the endpoint doesn't advertise
   * itself. */
  list = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (
        this.adminToken === "" ||
        req.header("x-admin-token") !== this.adminToken
      ) {
        throw new NotFoundError();
      }
      const reports = await this.service.listReports();
      res.json({
        reports: reports.map((r) => ({
          id: r.id,
          shareId: r.shareId,
          shareUrl: `/s/${r.shareId}`,
          note: r.note,
          createdAt: r.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  };
}
