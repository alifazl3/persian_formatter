import { Request, Response, NextFunction } from "express";
import { ShareService } from "../services/shareService";

interface CreateShareBody {
  content?: unknown;
}

/** HTTP layer: translates requests/responses to and from the service. */
export class ShareHandler {
  constructor(private readonly service: ShareService) {}

  create = async (
    req: Request<unknown, unknown, CreateShareBody>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const result = await this.service.createShare({
        content: req.body?.content,
      });
      res.status(201).json({ id: result.id, url: `/s/${result.id}` });
    } catch (err) {
      next(err);
    }
  };

  get = async (
    req: Request<{ id: string }>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const share = await this.service.getShare(req.params.id);
      res.json({
        id: share.id,
        content: share.content,
        createdAt: share.createdAt.toISOString(),
        viewCount: share.viewCount,
      });
    } catch (err) {
      next(err);
    }
  };
}
