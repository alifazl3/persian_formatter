import { NextFunction, Request, Response, Router } from "express";
import { AdminService } from "../services/adminService";
import { PrincipalLookup } from "./shareHandler";
import { NotFoundError } from "../errors";

type Handler = (req: Request, res: Response) => Promise<void>;

/**
 * The admin dashboard API under /api/admin. Only signed-in accounts whose
 * email is in ADMIN_EMAILS get through; everyone else gets a 404, so the
 * endpoints don't advertise themselves.
 */
export function createAdminRouter(service: AdminService, principal: PrincipalLookup): Router {
  const router = Router();
  router.use(async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const who = await principal(req, res, false);
      if (!service.isAdmin(who?.email)) throw new NotFoundError();
      next();
    } catch (error) { next(error); }
  });
  const route = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => { handler(req, res).catch(next); };

  router.get("/overview", route(async (req, res) => { res.json(await service.overview(req.query.days)); }));
  router.get("/users", route(async (req, res) => { res.json(await service.users(req.query)); }));
  router.get("/shares", route(async (req, res) => { res.json(await service.shares(req.query)); }));
  router.delete("/shares/:id", route(async (req, res) => { await service.deleteShare(String(req.params.id)); res.status(204).end(); }));
  router.get("/reports", route(async (req, res) => { res.json({ reports: await service.reports(req.query.status) }); }));
  router.post("/reports/:id/resolve", route(async (req, res) => { await service.resolveReport(req.params.id); res.status(204).end(); }));
  return router;
}
