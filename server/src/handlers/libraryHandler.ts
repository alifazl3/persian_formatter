import { NextFunction, Request, Response, Router } from "express";
import { AuthRouter } from "../auth";
import { LibraryService } from "../services/libraryService";

type Handler = (req: Request, res: Response) => Promise<void>;

/**
 * HTTP layer for the library. Every route acts as the caller's principal
 * (a guest session is created on first use), so no extra access headers are
 * needed: shared folders are reachable through membership.
 */
export function createLibraryRouter(service: LibraryService, auth: AuthRouter): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const route = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => { handler(req, res).catch(next); };
  const user = async (req: Request, res: Response) => (await auth.principal(req, res))!.id;

  router.get("/library", route(async (req, res) => {
    res.json(await service.library(await user(req, res)));
  }));

  router.get("/documents/:id", route(async (req, res) => {
    res.json(await service.getDocument(await user(req, res), req.params.id));
  }));
  router.post("/documents", route(async (req, res) => {
    res.status(201).json(await service.createDocument(await user(req, res), req.body ?? {}));
  }));
  router.patch("/documents/:id", route(async (req, res) => {
    res.json(await service.updateDocument(await user(req, res), req.params.id, req.body ?? {}));
  }));
  router.delete("/documents/:id", route(async (req, res) => {
    await service.deleteDocument(await user(req, res), req.params.id, req.query.version);
    res.status(204).end();
  }));

  router.post("/folders", route(async (req, res) => {
    res.status(201).json(await service.createFolder(await user(req, res), req.body ?? {}));
  }));
  router.patch("/folders/:id", route(async (req, res) => {
    res.json(await service.renameFolder(await user(req, res), req.params.id, req.body ?? {}));
  }));
  router.delete("/folders/:id", route(async (req, res) => {
    await service.deleteFolder(await user(req, res), req.params.id, req.query.documents === "delete");
    res.status(204).end();
  }));
  router.delete("/folders/:id/membership", route(async (req, res) => {
    await service.leaveFolder(await user(req, res), req.params.id);
    res.status(204).end();
  }));

  router.get("/folders/:id/links", route(async (req, res) => {
    res.json({ links: await service.listLinks(await user(req, res), req.params.id) });
  }));
  router.post("/folders/:id/links", route(async (req, res) => {
    res.status(201).json(await service.createLink(await user(req, res), req.params.id, req.body ?? {}));
  }));
  router.delete("/folders/:id/links/:linkId", route(async (req, res) => {
    await service.revokeLink(await user(req, res), req.params.id, req.params.linkId);
    res.status(204).end();
  }));
  router.get("/folders/:id/members", route(async (req, res) => {
    res.json({ members: await service.listMembers(await user(req, res), req.params.id) });
  }));
  router.delete("/folders/:id/members/:memberId", route(async (req, res) => {
    await service.removeMember(await user(req, res), req.params.id, req.params.memberId);
    res.status(204).end();
  }));

  router.get("/folder-links/:token", route(async (req, res) => {
    const visitor = await auth.principal(req, res, false);
    res.json(await service.previewLink(visitor?.id ?? null, req.params.token));
  }));
  router.post("/folder-links/:token/join", route(async (req, res) => {
    res.json(await service.joinLink(await user(req, res), req.params.token));
  }));

  return router;
}
