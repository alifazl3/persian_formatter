import { Pool } from "pg";
import { config } from "../config";

/** Shared connection pool for the application. */
export const pool: Pool = new Pool({
  connectionString: config.databaseUrl,
});
