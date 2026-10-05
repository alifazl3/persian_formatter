import { Router, Request, Response, NextFunction } from "express";
import { Pool } from "pg";
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from "crypto";
import { AppError, ValidationError } from "./errors";

type Principal = { id: string; email: string | null };
type Json = Record<string, unknown>;
const cookieName = "pf_session";
const challengeCookie = "pf_challenge";
const b64 = (value: Buffer) => value.toString("base64url");
const unb64 = (value: string) => Buffer.from(value, "base64url");
const token = () => b64(randomBytes(32));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const badAuth = () => new AppError(401, "AUTH_FAILED", "Passkey verification failed");

function cookie(req: Request, name: string): string | undefined {
  const part = (req.headers.cookie ?? "").split(";").map(x => x.trim()).find(x => x.startsWith(name + "="));
  return part?.slice(name.length + 1);
}
function setCookie(req: Request, res: Response, name: string, value: string, maxAge: number): void {
  const secure = (process.env.WEBAUTHN_ORIGIN ?? "").startsWith("https://") || req.secure || req.headers["x-forwarded-proto"] === "https";
  res.append("Set-Cookie", `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
}
function emailValue(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("A valid email is required");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("A valid email is required");
  return email;
}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Invalid passkey response");
  return value as Json;
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.length > 100000) throw badAuth();
  return value;
}
function expectedOrigin(req: Request): string {
  const configured = process.env.WEBAUTHN_ORIGIN;
  if (configured) return configured.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : req.protocol;
  return `${proto}://${req.get("host")}`;
}
function rpId(req: Request): string {
  return process.env.WEBAUTHN_RP_ID || new URL(expectedOrigin(req)).hostname;
}
function clientData(value: string, type: string, challenge: string, origin: string): Buffer {
  const raw = unb64(value);
  let parsed: Json;
  try { parsed = object(JSON.parse(raw.toString("utf8"))); } catch { throw badAuth(); }
  if (parsed.type !== type || parsed.challenge !== challenge || parsed.origin !== origin || parsed.crossOrigin === true) throw badAuth();
  return raw;
}

// Small, strict CBOR reader for authenticator attestation and COSE public keys.
function cbor(data: Buffer, start = 0, depth = 0): [unknown, number] {
  if (start >= data.length || depth > 16) throw badAuth();
  const first = data[start]!;
  const major = first >> 5;
  const info = first & 31;
  let at = start + 1;
  let size: number;
  if (info < 24) size = info;
  else if (info === 24) { if (at + 1 > data.length) throw badAuth(); size = data.readUInt8(at); at += 1; }
  else if (info === 25) { if (at + 2 > data.length) throw badAuth(); size = data.readUInt16BE(at); at += 2; }
  else if (info === 26) { if (at + 4 > data.length) throw badAuth(); size = data.readUInt32BE(at); at += 4; }
  else throw badAuth();
  if (major === 0) return [size, at];
  if (major === 1) return [-1 - size, at];
  if (major === 2 || major === 3) {
    if (at + size > data.length) throw badAuth();
    const slice = data.subarray(at, at + size);
    return [major === 2 ? slice : slice.toString("utf8"), at + size];
  }
  if (major === 4) {
    if (size > 1000) throw badAuth();
    const values: unknown[] = [];
    for (let i = 0; i < size; i++) { const [value, next] = cbor(data, at, depth + 1); values.push(value); at = next; }
    return [values, at];
  }
  if (major === 5) {
    if (size > 1000) throw badAuth();
    const values = new Map<unknown, unknown>();
    for (let i = 0; i < size; i++) {
      const [key, next] = cbor(data, at, depth + 1); const [value, end] = cbor(data, next, depth + 1);
      values.set(key, value); at = end;
    }
    return [values, at];
  }
  throw badAuth();
}
function authenticatorData(raw: Buffer, rp: string): { flags: number; count: number; credentialId?: string; publicKey?: Json } {
  if (raw.length < 37 || !raw.subarray(0, 32).equals(createHash("sha256").update(rp).digest())) throw badAuth();
  const flags = raw[32]!;
  if ((flags & 0x05) !== 0x05) throw badAuth(); // User presence and verification.
  const count = raw.readUInt32BE(33);
  if (!(flags & 0x40)) return { flags, count };
  if (raw.length < 55) throw badAuth();
  let at = 53; // 37-byte header plus 16-byte AAGUID.
  const length = raw.readUInt16BE(at); at += 2;
  if (length < 1 || at + length > raw.length) throw badAuth();
  const credentialId = b64(raw.subarray(at, at + length)); at += length;
  const [key] = cbor(raw, at);
  if (!(key instanceof Map)) throw badAuth();
  const kind = key.get(1);
  const algorithm = key.get(3);
  let publicKey: Json;
  if (kind === 2 && algorithm === -7 && key.get(-1) === 1 && Buffer.isBuffer(key.get(-2)) && Buffer.isBuffer(key.get(-3))) {
    publicKey = { kty: "EC", crv: "P-256", x: b64(key.get(-2) as Buffer), y: b64(key.get(-3) as Buffer) };
  } else if (kind === 3 && algorithm === -257 && Buffer.isBuffer(key.get(-1)) && Buffer.isBuffer(key.get(-2))) {
    publicKey = { kty: "RSA", n: b64(key.get(-1) as Buffer), e: b64(key.get(-2) as Buffer) };
  } else throw badAuth();
  return { flags, count, credentialId, publicKey };
}
function verifyRegistration(body: Json, challenge: string, origin: string, rp: string): { id: string; key: Json; count: number } {
  const response = object(body.response);
  clientData(string(response.clientDataJSON), "webauthn.create", challenge, origin);
  const [attestation] = cbor(unb64(string(response.attestationObject)));
  if (!(attestation instanceof Map) || attestation.get("fmt") !== "none" || !Buffer.isBuffer(attestation.get("authData"))) throw badAuth();
  const data = authenticatorData(attestation.get("authData") as Buffer, rp);
  if (!data.credentialId || !data.publicKey || data.credentialId !== body.id) throw badAuth();
  return { id: data.credentialId, key: data.publicKey, count: data.count };
}
function verifyLogin(body: Json, challenge: string, origin: string, rp: string, key: Json): number {
  const response = object(body.response);
  const client = clientData(string(response.clientDataJSON), "webauthn.get", challenge, origin);
  const auth = unb64(string(response.authenticatorData));
  const data = authenticatorData(auth, rp);
  const signed = Buffer.concat([auth, createHash("sha256").update(client).digest()]);
  const publicKey = createPublicKey({ key: key as any, format: "jwk" });
  if (!verifySignature("sha256", signed, publicKey, unb64(string(response.signature)))) throw badAuth();
  return data.count;
}

export function createAuthRouter(pool: Pool): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  async function principal(req: Request, res: Response, create = true): Promise<Principal | null> {
    const raw = cookie(req, cookieName);
    if (raw) {
      const found = await pool.query<Principal>(`SELECT o.id, o.email FROM sessions s JOIN owners o ON o.id=s.owner_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [hash(raw)]);
      if (found.rows[0]) return found.rows[0];
    }
    if (!create) return null;
    const ownerId = randomUUID(); const session = token();
    await pool.query("INSERT INTO owners(id) VALUES($1)", [ownerId]);
    await pool.query("INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,now()+interval '90 days')", [hash(session), ownerId]);
    setCookie(req, res, cookieName, session, 90 * 86400);
    return { id: ownerId, email: null };
  }
  async function challenge(req: Request, res: Response, purpose: "register" | "login", email: string, ownerId: string | null): Promise<string> {
    const value = token(); const challenge = token();
    await pool.query("INSERT INTO webauthn_challenges(token_hash,challenge,purpose,email,owner_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')", [hash(value), challenge, purpose, email, ownerId]);
    setCookie(req, res, challengeCookie, value, 300);
    return challenge;
  }
  async function takeChallenge(req: Request, purpose: string): Promise<{ challenge: string; email: string; owner_id: string | null }> {
    const raw = cookie(req, challengeCookie);
    if (!raw) throw badAuth();
    const result = await pool.query<{ challenge: string; email: string; owner_id: string | null }>("DELETE FROM webauthn_challenges WHERE token_hash=$1 AND purpose=$2 AND expires_at>now() RETURNING challenge,email,owner_id", [hash(raw), purpose]);
    if (!result.rows[0]) throw badAuth();
    return result.rows[0];
  }
  const wrap = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { handler(req, res).catch(next); };
  router.get("/identity", wrap(async (req, res) => { const who = await principal(req, res); res.json({ email: who!.email }); }));
  router.post("/auth/register/options", wrap(async (req, res) => {
    const email = emailValue(req.body?.email);
    const current = (await principal(req, res))!;
    if (current.email && current.email !== email) throw new AppError(409, "ACCOUNT_EXISTS", "Already signed in to another account");
    const existing = await pool.query("SELECT id FROM owners WHERE email=$1", [email]);
    if (existing.rows.length && existing.rows[0].id !== current.id) throw new AppError(409, "ACCOUNT_EXISTS", "This email already has an account");
    const value = await challenge(req, res, "register", email, current.id);
    res.json({ challenge: value, rp: { name: "Pretty Text Viewer", id: rpId(req) }, user: { id: b64(Buffer.from(current.id)), name: email, displayName: email }, pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }], timeout: 300000, attestation: "none", authenticatorSelection: { residentKey: "preferred", userVerification: "required" } });
  }));
  router.post("/auth/register/verify", wrap(async (req, res) => {
    const stored = await takeChallenge(req, "register");
    const who = await principal(req, res, false);
    if (!who || who.id !== stored.owner_id) throw badAuth();
    const verified = verifyRegistration(object(req.body), stored.challenge, expectedOrigin(req), rpId(req));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query("UPDATE owners SET email=$1 WHERE id=$2 AND (email IS NULL OR email=$1)", [stored.email, who.id]);
      if (!updated.rowCount) throw badAuth();
      await client.query("INSERT INTO webauthn_credentials(id,owner_id,public_key,sign_count) VALUES($1,$2,$3,$4)", [verified.id, who.id, verified.key, verified.count]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); if ((error as {code?: string}).code === "23505") throw new AppError(409, "ACCOUNT_EXISTS", "Email or passkey already registered"); throw error; }
    finally { client.release(); }
    res.json({ email: stored.email });
  }));
  router.post("/auth/login/options", wrap(async (req, res) => {
    const email = emailValue(req.body?.email);
    const credentials = await pool.query<{ id: string }>("SELECT c.id FROM webauthn_credentials c JOIN owners o ON o.id=c.owner_id WHERE o.email=$1", [email]);
    if (!credentials.rows.length) throw new AppError(404, "ACCOUNT_NOT_FOUND", "No passkey for this email");
    const value = await challenge(req, res, "login", email, null);
    res.json({ challenge: value, rpId: rpId(req), timeout: 300000, userVerification: "required", allowCredentials: credentials.rows.map(row => ({ id: row.id, type: "public-key" })) });
  }));
  router.post("/auth/login/verify", wrap(async (req, res) => {
    const stored = await takeChallenge(req, "login");
    const body = object(req.body); const id = string(body.id);
    const result = await pool.query<{ owner_id: string; public_key: Json; sign_count: string }>("SELECT c.owner_id,c.public_key,c.sign_count FROM webauthn_credentials c JOIN owners o ON o.id=c.owner_id WHERE c.id=$1 AND o.email=$2", [id, stored.email]);
    const credential = result.rows[0]; if (!credential) throw badAuth();
    const count = verifyLogin(body, stored.challenge, expectedOrigin(req), rpId(req), credential.public_key);
    if (count && count <= Number(credential.sign_count)) throw badAuth();
    const old = await principal(req, res, false);
    const session = token(); const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE webauthn_credentials SET sign_count=$1 WHERE id=$2", [count, id]);
      await client.query("INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,now()+interval '90 days')", [hash(session), credential.owner_id]);
      if (old && !old.email && old.id !== credential.owner_id) {
        // Move the guest's library and shared-folder memberships to the account.
        await client.query(`INSERT INTO folder_members(folder_id,member_id,access,link_hash,joined_at)
          SELECT m.folder_id,$1,m.access,m.link_hash,m.joined_at FROM folder_members m JOIN folders f ON f.id=m.folder_id
          WHERE m.member_id=$2 AND f.owner_id<>$1 ON CONFLICT (folder_id,member_id) DO NOTHING`, [credential.owner_id, old.id]);
        await client.query("UPDATE folders SET owner_id=$1 WHERE owner_id=$2", [credential.owner_id, old.id]);
        await client.query("UPDATE saved_items SET owner_id=$1 WHERE owner_id=$2", [credential.owner_id, old.id]);
        await client.query("DELETE FROM folder_members m USING folders f WHERE f.id=m.folder_id AND m.member_id=$1 AND f.owner_id=$1", [credential.owner_id]);
        await client.query("DELETE FROM owners WHERE id=$1", [old.id]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    setCookie(req, res, cookieName, session, 90 * 86400);
    res.json({ email: stored.email });
  }));
  router.post("/auth/logout", wrap(async (req, res) => {
    const raw = cookie(req, cookieName);
    if (raw) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [hash(raw)]);
    setCookie(req, res, cookieName, "", 0);
    res.json({ ok: true });
  }));
  // Library routes use the same opaque session, including guest sessions.
  (router as Router & { principal: typeof principal }).principal = principal;
  return router;
}
export type AuthRouter = Router & { principal: (req: Request, res: Response, create?: boolean) => Promise<Principal | null> };
export { hash, token, cookie };
