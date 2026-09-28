import express, { Application } from "express";
import path from "path";
import { config } from "./config";
import { ShareHandler } from "./handlers/shareHandler";
import { ReportHandler } from "./handlers/reportHandler";
import { createApiRouter } from "./routes";
import { errorHandler } from "./middleware/errorHandler";
import { AuthRouter } from "./auth";
import { Router } from "express";

/** Builds the Express application: JSON API under /api + the static frontend. */
export function createApp(
  shareHandler: ShareHandler,
  reportHandler: ReportHandler,
  authRouter: AuthRouter,
  libraryRouter: Router
): Application {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.use("/api", createApiRouter(shareHandler, reportHandler));
  app.use("/api", authRouter);
  app.use("/api", libraryRouter);

  // Static frontend. The share view (/s/:id) serves the same SPA; the client
  // reads the id from the path and fetches the content from the API.
  const indexFile = path.join(config.publicDir, "index.html");
  app.use(express.static(config.publicDir, { index: false }));
  app.get(["/", "/s/:id", "/f/:token", "/date"], (_req, res) => {
    res.sendFile(indexFile);
  });

  app.use(errorHandler);
  return app;
}
