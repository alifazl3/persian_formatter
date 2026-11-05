import { Request, Response, NextFunction } from "express";
import { readFile } from "fs/promises";
import { ShareService } from "../services/shareService";
import { sharePreview } from "../services/sharePreview";
import { ShareSummary } from "../domain/share";
import { NotFoundError } from "../errors";

interface CreateShareBody {
  content?: unknown;
}

/** Resolves the caller's owner id; `create` starts a guest session if needed. */
export type PrincipalLookup = (req: Request, res: Response, create?: boolean) => Promise<{ id: string; email?: string | null } | null>;

const SITE_NAME = "پرشین فرمتر";

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function summaryJson(share: ShareSummary) {
  return {
    id: share.id,
    url: `/s/${share.id}`,
    title: share.title,
    createdAt: share.createdAt.toISOString(),
    viewCount: share.viewCount,
    expiresAt: share.expiresAt?.toISOString() ?? null,
    linked: share.documentId !== null,
    live: share.live,
  };
}

/** HTTP layer: translates requests/responses to and from the service. */
export class ShareHandler {
  constructor(
    private readonly service: ShareService,
    private readonly principal: PrincipalLookup,
    private readonly indexFile: string,
    private readonly origin: (req: Request) => string
  ) {}

  create = async (
    req: Request<unknown, unknown, CreateShareBody>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const owner = await this.principal(req as Request, res);
      const result = await this.service.createShare({
        content: req.body?.content,
        documentId: (req.body as { documentId?: unknown })?.documentId,
      }, owner?.id ?? null);
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
      const viewer = await this.principal(req as Request, res, false);
      const share = await this.service.getShare(req.params.id, viewer?.id ?? null);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        id: share.id,
        content: share.content,
        createdAt: share.createdAt.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  };

  /** The caller's own links, newest first. */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const owner = await this.principal(req, res, false);
      const shares = owner ? await this.service.listShares(owner.id) : [];
      res.setHeader("Cache-Control", "no-store");
      res.json({ shares: shares.map(summaryJson) });
    } catch (err) {
      next(err);
    }
  };

  update = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
    try {
      const owner = await this.principal(req as Request, res, false);
      if (!owner) throw new NotFoundError("Share not found");
      const share = await this.service.updateShare(owner.id, req.params.id, req.body ?? {});
      res.json(summaryJson(share));
    } catch (err) {
      next(err);
    }
  };

  remove = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
    try {
      const owner = await this.principal(req as Request, res, false);
      if (!owner) throw new NotFoundError("Share not found");
      await this.service.deleteShare(owner.id, req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  };

  /** The /s/:id page: the app shell with the text's title and summary as
   * og:/twitter: tags, so messengers (Telegram, WhatsApp) show a preview.
   * Crawlers fetch this page, so it never counts a view. */
  page = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
    try {
      let html = await readFile(this.indexFile, "utf8");
      const share = await this.service.findActive(req.params.id);
      if (share) {
        const { title, description } = sharePreview(share.content);
        const origin = this.origin(req as Request);
        const tags = [
          `<title>${escapeHtml(title ? `${title} · ${SITE_NAME}` : SITE_NAME)}</title>`,
          description && `<meta name="description" content="${escapeHtml(description)}" />`,
          `<meta property="og:site_name" content="${SITE_NAME}" />`,
          `<meta property="og:type" content="article" />`,
          `<meta property="og:locale" content="fa_IR" />`,
          `<meta property="og:title" content="${escapeHtml(title || SITE_NAME)}" />`,
          description && `<meta property="og:description" content="${escapeHtml(description)}" />`,
          `<meta property="og:url" content="${escapeHtml(`${origin}/s/${share.id}`)}" />`,
          `<meta property="og:image" content="${escapeHtml(`${origin}/icon-512.png`)}" />`,
          `<meta name="twitter:card" content="summary" />`,
        ].filter(Boolean).join("\n  ");
        html = html.replace(/<title>[^<]*<\/title>/, () => tags);
      }
      res.setHeader("Cache-Control", "no-cache");
      res.type("html").send(html);
    } catch (err) {
      next(err);
    }
  };
}
