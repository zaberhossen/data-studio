/**
 * Password hashing for the Credentials provider.
 *
 * Uses Node's built-in scrypt (memory-hard KDF) — no native dependency, no build
 * step. A per-password random salt is stored alongside the derived key in a
 * single `scrypt$N$r$p$salt$hash` string; verification is constant-time.
 *
 * SERVER-ONLY.
 */

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/** Promise wrapper around scrypt that supports the options argument. */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

// scrypt cost parameters. N must be a power of two; these give a ~100ms hash on
// typical hardware while staying within Node's default maxmem.
const N = 16384; // CPU/memory cost
const R = 8; // block size
const P = 1; // parallelization
const KEYLEN = 64;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scryptAsync(password.normalize("NFKC"), salt, KEYLEN, {
    N,
    r: R,
    p: P,
  })) as Buffer;
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  const derived = (await scryptAsync(password.normalize("NFKC"), salt, expected.length, {
    N: n,
    r,
    p,
  })) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
