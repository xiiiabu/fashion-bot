/**
 * Cryptographic helpers built on node:crypto only.
 *
 * Deliberately dependency-free: password hashing, session tokens, HMAC
 * signatures, TOTP and the hashing used to keep IPs out of logs are all
 * primitives the platform already ships, and every extra native dependency is
 * a supply-chain and build risk (SEC-011).
 */

import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  type ScryptOptions,
  timingSafeEqual,
} from 'node:crypto';

/**
 * node:util's promisify overloads do not cover scrypt's options argument, so
 * the wrapper is written out rather than cast.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

const SCRYPT_KEYLEN = 32;
const SCRYPT_COST = 2 ** 15;
const SCRYPT_BLOCK = 8;
const SCRYPT_PARALLEL = 1;
/**
 * scrypt needs roughly 128 * N * r bytes. At N=32768, r=8 that is ~33 MB,
 * just over Node's 32 MB default, so the limit is raised explicitly rather
 * than weakening the cost parameters.
 */
const SCRYPT_MAXMEM = 96 * 1024 * 1024;

/** scrypt with per-password salt, stored as `scrypt$N$r$p$salt$hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK,
    p: SCRYPT_PARALLEL,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    SCRYPT_COST,
    SCRYPT_BLOCK,
    SCRYPT_PARALLEL,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, costRaw, blockRaw, parallelRaw, saltRaw, hashRaw] = parts;
  const salt = Buffer.from(saltRaw!, 'base64url');
  const expected = Buffer.from(hashRaw!, 'base64url');
  try {
    const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N: Number.parseInt(costRaw!, 10),
      r: Number.parseInt(blockRaw!, 10),
      p: Number.parseInt(parallelRaw!, 10),
      maxmem: SCRYPT_MAXMEM,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** §14.3 / ADM-006: store a hash, never the raw IP. */
export function hashIp(ip: string | undefined, pepper: string): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${pepper}:${ip}`).digest('hex').slice(0, 32);
}

export function uuid(): string {
  return randomUUID();
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

// ───────────────────────────────────────────────────── compact JWT (HS256)

interface JwtPayload {
  [key: string]: unknown;
  sub: string;
  exp: number;
  iat: number;
}

export function signJwt(payload: Record<string, unknown>, secret: string, ttlSeconds: number): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedBody = base64url(JSON.stringify(body));
  const signature = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedBody}`)
    .digest('base64url');
  return `${encodedHeader}.${encodedBody}.${signature}`;
}

export function verifyJwt<T extends JwtPayload = JwtPayload>(token: string, secret: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedBody, signature] = parts as [string, string, string];
  const expected = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedBody}`)
    .digest('base64url');
  if (!constantTimeEqual(expected, signature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedBody, 'base64url').toString('utf8')) as T;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

// ─────────────────────────────────────────────────────────── TOTP (ADM-002)

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function totpUri(secret: string, account: string, issuer = 'Fashion Marketplace'): string {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${params.toString()}`;
}

export function totpCode(secret: string, timestamp = Date.now(), period = 30): string {
  const counter = Math.floor(timestamp / 1000 / period);
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

/** Accepts the neighbouring windows so a slow phone clock still works. */
export function verifyTotp(secret: string, code: string, window = 1): boolean {
  const normalized = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const now = Date.now();
  for (let drift = -window; drift <= window; drift += 1) {
    const candidate = totpCode(secret, now + drift * 30_000);
    if (constantTimeEqual(candidate, normalized)) return true;
  }
  return false;
}

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ──────────────────────────────────────────────── webhook signatures (PAY-004)

export function hmacHex(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyHmac(payload: string, secret: string, signature: string): boolean {
  return constantTimeEqual(hmacHex(payload, secret), signature.trim().toLowerCase());
}

/** Stable hash of a request body, used to detect idempotency-key reuse. */
export function requestHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}
