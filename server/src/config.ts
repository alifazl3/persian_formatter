import path from "path";

/** Fully-typed runtime configuration, read once from the environment. */
export interface Config {
  readonly port: number;
  readonly databaseUrl: string;
  /** Directory containing index.html (and any other static assets). */
  readonly publicDir: string;
  /** Maximum length (in characters) of a shared document. */
  readonly maxContentLength: number;
}

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got: ${raw}`);
  }
  return parsed;
}

export const config: Config = {
  port: numberEnv("PORT", 3000),
  databaseUrl: requireEnv(
    "DATABASE_URL",
    "postgres://postgres:mysecretpassword@localhost:5432/persian_formatter"
  ),
  // In dev the compiled file lives at server/dist/config.js, so ../../ is the
  // repo root where index.html sits. In Docker this is overridden via PUBLIC_DIR.
  publicDir: process.env.PUBLIC_DIR ?? path.resolve(__dirname, "..", ".."),
  maxContentLength: numberEnv("MAX_CONTENT_LENGTH", 200_000),
};
