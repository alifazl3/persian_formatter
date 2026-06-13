import { config } from "./config";
import { pool } from "./db/pool";
import { migrate } from "./db/migrate";
import { PgShareRepository } from "./repositories/shareRepository";
import { ShareService } from "./services/shareService";
import { ShareHandler } from "./handlers/shareHandler";
import { createApp } from "./app";

async function main(): Promise<void> {
  await migrate(pool);

  // Compose the layers: repository → service → handler.
  const repository = new PgShareRepository(pool);
  const service = new ShareService(repository, config.maxContentLength);
  const handler = new ShareHandler(service);

  const app = createApp(handler);
  app.listen(config.port, () => {
    console.log(`Server listening on http://0.0.0.0:${config.port}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
