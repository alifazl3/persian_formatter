import { Router } from "express";
import { ShareHandler } from "./handlers/shareHandler";

/** Wires the share endpoints onto an /api router. */
export function createApiRouter(shareHandler: ShareHandler): Router {
  const router = Router();

  router.post("/shares", shareHandler.create);
  router.get("/shares/:id", shareHandler.get);

  return router;
}
