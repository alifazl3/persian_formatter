import { Router } from "express";
import { ShareHandler } from "./handlers/shareHandler";
import { ReportHandler } from "./handlers/reportHandler";

/** Wires the share + report endpoints onto an /api router. */
export function createApiRouter(
  shareHandler: ShareHandler,
  reportHandler: ReportHandler
): Router {
  const router = Router();

  router.post("/shares", shareHandler.create);
  router.get("/shares/:id", shareHandler.get);

  router.post("/shares/:id/reports", reportHandler.create);
  router.get("/reports", reportHandler.list);

  return router;
}
