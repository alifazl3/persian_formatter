import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";
import { createAuthRouter } from "../src/auth";

const origin = "https://example.test";
const rpId = "example.test";
const challenge = randomBytes(32).toString("base64url");
const credentialId = randomBytes(32).toString("base64url");
const ownerId = randomUUID();
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

function loginResponse(responseOrigin = origin, counter = 1) {
  const client = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: responseOrigin }));
  const authenticator = Buffer.alloc(37);
  createHash("sha256").update(rpId).digest().copy(authenticator);
  authenticator[32] = 0x05;
  authenticator.writeUInt32BE(counter, 33);
  const signed = Buffer.concat([authenticator, createHash("sha256").update(client).digest()]);
  return {
    id: credentialId,
    response: {
      clientDataJSON: client.toString("base64url"),
      authenticatorData: authenticator.toString("base64url"),
      signature: sign("sha256", signed, privateKey).toString("base64url"),
    },
  };
}

async function verify(body: object, storedCounter = 0) {
  const queries: string[] = [];
  const client = {
    async query(sql: string) { queries.push(sql); return { rows: [], rowCount: 1 }; },
    release() {},
  };
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.startsWith("DELETE FROM webauthn_challenges")) return { rows: [{ challenge, email: "user@example.test", owner_id: null }] };
      if (sql.startsWith("SELECT c.owner_id")) return { rows: [{ owner_id: ownerId, public_key: publicKey.export({ format: "jwk" }), sign_count: String(storedCounter) }] };
      if (sql.startsWith("SELECT o.id")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async connect() { return client; },
  } as unknown as Pool;
  const router = createAuthRouter(pool);
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === "/auth/login/verify");
  const handler = layer.route.stack[0].handle;
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  let error: unknown;
  const req = {
    body,
    headers: { cookie: "pf_challenge=challenge-cookie", host: rpId },
    protocol: "https",
    get: (name: string) => name === "host" ? rpId : undefined,
  };
  const response = {
    body: undefined as any,
    append: (_header: string, _value: string) => {},
    json(value: unknown) { this.body = value; finish(); return this; },
  };
  handler(req, response, (caught: unknown) => { error = caught; finish(); });
  await completed;
  return { error, response, queries };
}

test("login accepts a correctly signed passkey assertion", async () => {
  const result = await verify(loginResponse());
  assert.equal(result.error, undefined);
  assert.deepEqual(result.response.body, { email: "user@example.test" });
  assert.ok(result.queries.some(sql => sql.startsWith("INSERT INTO sessions")));
});

test("login rejects a passkey assertion from another origin", async () => {
  const result = await verify(loginResponse("https://attacker.test"));
  assert.equal((result.error as any)?.statusCode, 401);
  assert.equal(result.queries.some(sql => sql.startsWith("INSERT INTO sessions")), false);
});

test("login rejects an old authenticator counter", async () => {
  const result = await verify(loginResponse(origin, 2), 2);
  assert.equal((result.error as any)?.statusCode, 401);
  assert.equal(result.queries.some(sql => sql.startsWith("INSERT INTO sessions")), false);
});

function cbor(value: number | string | Buffer | Map<number | string, unknown>): Buffer {
  const head = (major: number, size: number) => size < 24 ? Buffer.from([(major << 5) | size]) : size < 256 ? Buffer.from([(major << 5) | 24, size]) : Buffer.from([(major << 5) | 25, size >> 8, size & 255]);
  if (typeof value === "number") return head(value >= 0 ? 0 : 1, value >= 0 ? value : -1 - value);
  if (typeof value === "string") { const data = Buffer.from(value); return Buffer.concat([head(3, data.length), data]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  const parts: Buffer[] = [];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item as any));
  return Buffer.concat([head(5, value.size), ...parts]);
}

test("registration accepts a valid WebAuthn none attestation", async () => {
  const jwk = publicKey.export({ format: "jwk" });
  const cose = cbor(new Map<number, unknown>([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")],
  ]));
  const credentialBytes = Buffer.from(credentialId, "base64url");
  const auth = Buffer.alloc(55);
  createHash("sha256").update(rpId).digest().copy(auth);
  auth[32] = 0x45;
  auth.writeUInt16BE(credentialBytes.length, 53);
  const attestation = cbor(new Map<string, unknown>([
    ["fmt", "none"],
    ["authData", Buffer.concat([auth, credentialBytes, cose])],
    ["attStmt", new Map()],
  ]));
  const body = {
    id: credentialId,
    response: {
      clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin })).toString("base64url"),
      attestationObject: attestation.toString("base64url"),
    },
  };
  const queries: string[] = [];
  const client = {
    async query(sql: string) { queries.push(sql); return { rows: [], rowCount: 1 }; },
    release() {},
  };
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.startsWith("DELETE FROM webauthn_challenges")) return { rows: [{ challenge, email: "user@example.test", owner_id: ownerId }] };
      if (sql.startsWith("SELECT o.id")) return { rows: [{ id: ownerId, email: null }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async connect() { return client; },
  } as unknown as Pool;
  const router = createAuthRouter(pool);
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === "/auth/register/verify");
  const handler = layer.route.stack[0].handle;
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  let error: unknown;
  let result: unknown;
  const req = { body, headers: { cookie: "pf_challenge=challenge-cookie; pf_session=session-cookie", host: rpId }, protocol: "https", get: (name: string) => name === "host" ? rpId : undefined };
  handler(req, { json(value: unknown) { result = value; finish(); } }, (caught: unknown) => { error = caught; finish(); });
  await completed;
  assert.equal(error, undefined);
  assert.deepEqual(result, { email: "user@example.test" });
  assert.ok(queries.some(sql => sql.startsWith("INSERT INTO webauthn_credentials")));
});
