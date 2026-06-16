import crypto from "node:crypto";
import Redis from "ioredis";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Client {
  clientId: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  createdAt: number;
}

interface AuthCode {
  clientId: string;
  redirectUri: string;
  shiprocketToken: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource?: string;
  expiresAt: number;
}

export interface AccessTokenData {
  clientId: string;
  shiprocketToken: string;
  scope: string;
  resource?: string;
  expiresAt: number;
}

// ─── Redis key helpers ────────────────────────────────────────────────────────

const K = {
  client: (id: string) => `sr:client:${id}`,
  authCode: (code: string) => `sr:authcode:${code}`,
  accessToken: (token: string) => `sr:at:${token}`,
  refreshToken: (token: string) => `sr:rt:${token}`,
  atToRt: (accessToken: string) => `sr:at_to_rt:${accessToken}`,
};

const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60; // 30 days
const ACCESS_TOKEN_TTL_S = 3_600;               // 1 hour
const AUTH_CODE_TTL_S = 60;                     // 60 seconds

// ─── Backend selection ────────────────────────────────────────────────────────

let redis: Redis | null = null;

if (process.env.REDIS_HOST) {
  redis = new Redis({
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    password: process.env.REDIS_PASSWORD,
    tls: process.env.REDIS_TLS === "true" ? {} : undefined,
    lazyConnect: false,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  });

  redis.on("error", (err) => console.error("Redis error:", err.message));
  redis.on("connect", () => console.log("Redis connected"));
}

// ─── In-memory fallback stores (dev only) ─────────────────────────────────────

const memClients = new Map<string, Client>();
const memAuthCodes = new Map<string, AuthCode>();

interface MemAccessToken {
  data: AccessTokenData;
  expiresAt: number;
}
interface RefreshTokenData {
  linkedAccessToken: string;
  clientId: string;
  shiprocketToken: string;
  scope: string;
  resource?: string;
}
interface MemRefreshToken {
  data: RefreshTokenData;
  expiresAt: number;
}
const memAccessTokens = new Map<string, MemAccessToken>();
const memRefreshTokens = new Map<string, MemRefreshToken>();

// Clean up expired in-memory entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memAuthCodes) { if (v.expiresAt < now) memAuthCodes.delete(k); }
  for (const [k, v] of memAccessTokens) { if (v.expiresAt < now) memAccessTokens.delete(k); }
  for (const [k, v] of memRefreshTokens) { if (v.expiresAt < now) memRefreshTokens.delete(k); }
}, 60_000).unref();

// ─── Client registration ──────────────────────────────────────────────────────

export async function registerClient(data: Omit<Client, "clientId" | "createdAt">): Promise<Client> {
  const clientId = `sr_client_${crypto.randomBytes(16).toString("hex")}`;
  const client: Client = { ...data, clientId, createdAt: Date.now() };

  if (redis) {
    await redis.set(K.client(clientId), JSON.stringify(client));
  } else {
    memClients.set(clientId, client);
  }

  return client;
}

export async function getClient(clientId: string): Promise<Client | undefined> {
  if (redis) {
    const raw = await redis.get(K.client(clientId));
    return raw ? (JSON.parse(raw) as Client) : undefined;
  }
  return memClients.get(clientId);
}

// ─── Auth codes (60s TTL, one-time use) ──────────────────────────────────────

export async function storeAuthCode(code: string, data: Omit<AuthCode, "expiresAt">): Promise<void> {
  const entry: AuthCode = { ...data, expiresAt: Date.now() + AUTH_CODE_TTL_S * 1000 };

  if (redis) {
    await redis.set(K.authCode(code), JSON.stringify(entry), "EX", AUTH_CODE_TTL_S);
  } else {
    memAuthCodes.set(code, entry);
  }
}

export async function consumeAuthCode(code: string): Promise<AuthCode | undefined> {
  if (redis) {
    const key = K.authCode(code);
    const raw = await redis.get(key);
    await redis.del(key); // one-time use regardless
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as AuthCode;
    if (entry.expiresAt < Date.now()) return undefined;
    return entry;
  }

  const entry = memAuthCodes.get(code);
  memAuthCodes.delete(code);
  if (!entry || entry.expiresAt < Date.now()) return undefined;
  return entry;
}

// ─── Access + refresh tokens ──────────────────────────────────────────────────

export async function issueTokens(
  data: Omit<AccessTokenData, "expiresAt">
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = `mcp_${crypto.randomBytes(24).toString("hex")}`;
  const refreshToken = `mcp_r_${crypto.randomBytes(24).toString("hex")}`;

  const atData: AccessTokenData = { ...data, expiresAt: Date.now() + ACCESS_TOKEN_TTL_S * 1000 };
  // Refresh tokens carry the session data themselves so rotation never depends
  // on the (much shorter-lived) access token record still being in the store.
  const rtData: RefreshTokenData = { linkedAccessToken: accessToken, ...data };

  if (redis) {
    const pipeline = redis.pipeline();
    pipeline.set(K.accessToken(accessToken), JSON.stringify(atData), "EX", ACCESS_TOKEN_TTL_S);
    pipeline.set(K.refreshToken(refreshToken), JSON.stringify(rtData), "EX", REFRESH_TOKEN_TTL_S);
    pipeline.set(K.atToRt(accessToken), refreshToken, "EX", REFRESH_TOKEN_TTL_S);
    await pipeline.exec();
  } else {
    memAccessTokens.set(accessToken, { data: atData, expiresAt: atData.expiresAt });
    memRefreshTokens.set(refreshToken, {
      data: rtData,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_S * 1000,
    });
  }

  return { accessToken, refreshToken };
}

export async function getAccessTokenData(token: string): Promise<AccessTokenData | undefined> {
  if (redis) {
    const raw = await redis.get(K.accessToken(token));
    if (!raw) return undefined;
    const data = JSON.parse(raw) as AccessTokenData;
    if (data.expiresAt < Date.now()) return undefined;
    return data;
  }

  const entry = memAccessTokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) return undefined;
  return entry.data;
}

export async function revokeAccessToken(accessToken: string): Promise<void> {
  if (redis) {
    const rtKey = K.atToRt(accessToken);
    const refreshToken = await redis.get(rtKey);
    const pipeline = redis.pipeline();
    pipeline.del(K.accessToken(accessToken));
    pipeline.del(rtKey);
    if (refreshToken) pipeline.del(K.refreshToken(refreshToken));
    await pipeline.exec();
  } else {
    memAccessTokens.delete(accessToken);
    for (const [rt, entry] of memRefreshTokens) {
      if (entry.data.linkedAccessToken === accessToken) { memRefreshTokens.delete(rt); break; }
    }
  }
}

export async function rotateTokens(
  oldRefreshToken: string
): Promise<{ accessToken: string; refreshToken: string; data: AccessTokenData; oldAccessToken: string } | undefined> {
  if (redis) {
    const rtKey = K.refreshToken(oldRefreshToken);
    const rtRaw = await redis.get(rtKey);
    if (!rtRaw) return undefined;

    let rtData: RefreshTokenData;
    try {
      rtData = JSON.parse(rtRaw) as RefreshTokenData;
    } catch {
      // Pre-fix refresh token record (plain access-token-id string) — no
      // session data to recover from it, so treat it as invalid.
      await redis.del(rtKey);
      return undefined;
    }

    const oldAccessToken = rtData.linkedAccessToken;

    // Invalidate old pair atomically. The access token record may already
    // be gone (TTL'd out) — deleting a missing key is a harmless no-op.
    const pipeline = redis.pipeline();
    pipeline.del(rtKey);
    pipeline.del(K.accessToken(oldAccessToken));
    pipeline.del(K.atToRt(oldAccessToken));
    await pipeline.exec();

    const data: AccessTokenData = {
      clientId: rtData.clientId,
      shiprocketToken: rtData.shiprocketToken,
      scope: rtData.scope,
      resource: rtData.resource,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_S * 1000,
    };

    const tokens = await issueTokens({
      clientId: rtData.clientId,
      shiprocketToken: rtData.shiprocketToken,
      scope: rtData.scope,
      resource: rtData.resource,
    });

    return { ...tokens, data, oldAccessToken };
  }

  // In-memory path
  const entry = memRefreshTokens.get(oldRefreshToken);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    memRefreshTokens.delete(oldRefreshToken);
    return undefined;
  }

  const { linkedAccessToken: oldAccessToken, ...sessionData } = entry.data;

  memRefreshTokens.delete(oldRefreshToken);
  memAccessTokens.delete(oldAccessToken);

  const data: AccessTokenData = { ...sessionData, expiresAt: Date.now() + ACCESS_TOKEN_TTL_S * 1000 };

  const tokens = await issueTokens(sessionData);

  return { ...tokens, data, oldAccessToken };
}
