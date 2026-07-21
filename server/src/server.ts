import { config } from "./config";
import { pool } from "./db/pool";
import { migrate } from "./db/migrate";
import { PgShareRepository } from "./repositories/shareRepository";
import { PgReportRepository } from "./repositories/reportRepository";
import { ShareService } from "./services/shareService";
import { ReportService } from "./services/reportService";
import { ShareHandler } from "./handlers/shareHandler";
import { ReportHandler } from "./handlers/reportHandler";
import { createApp } from "./app";

async function main(): Promise<void> {
  await migrate(pool);

  // Compose the layers: repository → service → handler.
  const repository = new PgShareRepository(pool);
  const service = new ShareService(repository, config.maxContentLength);
  const handler = new ShareHandler(service);

  const reportRepository = new PgReportRepository(pool);
  const reportService = new ReportService(reportRepository, repository);
  const reportHandler = new ReportHandler(reportService, config.adminToken);

  const app = createApp(handler, reportHandler);
  app.listen(config.port, () => {
    console.log(`Server listening on http://0.0.0.0:${config.port}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
