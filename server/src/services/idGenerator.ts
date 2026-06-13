import { randomBytes } from "crypto";

/**
 * Generate a short, URL-safe, hard-to-guess id (~12 chars).
 * 9 random bytes → 72 bits of entropy, encoded as base64url.
 */
export function generateId(): string {
  return randomBytes(9).toString("base64url");
}
