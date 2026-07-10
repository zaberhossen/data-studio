/**
 * Credential encryption at rest.
 *
 * Data-source secrets (host/user/password/tokens) must never sit in plaintext.
 * Every secret is sealed with AES-256-GCM before it touches the database and
 * opened only server-side, inside `DbSourceStore.get()`. The ciphertext, the
 * random IV, and the GCM auth tag are stored in separate columns; the plaintext
 * never leaves this module.
 *
 * SERVER-ONLY: this module reads the app encryption key from the environment and
 * must never be imported into a client component or worker.
 *
 * Key management + rotation. Keys are versioned so we can rotate without a bulk
 * re-encrypt: every sealed record stores the `keyVersion` it was sealed with, and
 * `open()` picks the matching key from the keyring. New writes always use the
 * highest (current) version. Configure via either:
 *   - `DATA_STUDIO_ENC_KEY`  — a single base64 32-byte key (becomes version 1), or
 *   - `DATA_STUDIO_ENC_KEYS` — `1:<base64>,2:<base64>,…`; the highest version is
 *                              the current key used for new writes.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length

/** A sealed secret. Stored as three `bytea` columns + an int `key_version`. */
export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

interface Keyring {
  keys: Map<number, Buffer>;
  current: number;
}

const globalForCrypto = globalThis as unknown as { __dataStudioKeyring?: Keyring };

/** Parse + cache the keyring from env. Throws if no valid key is configured. */
function keyring(): Keyring {
  if (globalForCrypto.__dataStudioKeyring) return globalForCrypto.__dataStudioKeyring;

  const keys = new Map<number, Buffer>();

  const multi = process.env.DATA_STUDIO_ENC_KEYS;
  const single = process.env.DATA_STUDIO_ENC_KEY;

  if (multi) {
    for (const entry of multi.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const sep = trimmed.indexOf(":");
      if (sep === -1) {
        throw new Error(
          `DATA_STUDIO_ENC_KEYS entry "${trimmed}" must be "<version>:<base64key>".`,
        );
      }
      const version = Number(trimmed.slice(0, sep));
      const key = decodeKey(trimmed.slice(sep + 1));
      if (!Number.isInteger(version) || version <= 0) {
        throw new Error(`DATA_STUDIO_ENC_KEYS has an invalid version: "${trimmed}".`);
      }
      keys.set(version, key);
    }
  } else if (single) {
    keys.set(1, decodeKey(single));
  }

  if (keys.size === 0) {
    throw new Error(
      "No encryption key configured. Set DATA_STUDIO_ENC_KEY (base64 32-byte) " +
        "or DATA_STUDIO_ENC_KEYS. Generate one with: " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`.",
    );
  }

  const current = Math.max(...keys.keys());
  const ring: Keyring = { keys, current };
  globalForCrypto.__dataStudioKeyring = ring;
  return ring;
}

function decodeKey(b64: string): Buffer {
  const key = Buffer.from(b64.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must be ${KEY_BYTES} bytes (base64-encoded); got ${key.length}.`,
    );
  }
  return key;
}

/** Seal an arbitrary JSON-serializable secret with the current key. */
export function seal(secret: unknown): SealedSecret {
  const ring = keyring();
  const key = ring.keys.get(ring.current)!;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(secret), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag, keyVersion: ring.current };
}

/** Open a sealed secret, verifying the auth tag. Throws on tamper / wrong key. */
export function open<T = unknown>(sealed: SealedSecret): T {
  const ring = keyring();
  const key = ring.keys.get(sealed.keyVersion);
  if (!key) {
    throw new Error(
      `No encryption key for version ${sealed.keyVersion}. Was a key removed from the keyring?`,
    );
  }
  const decipher = createDecipheriv(ALGORITHM, key, sealed.iv);
  decipher.setAuthTag(sealed.tag);
  const plaintext = Buffer.concat([
    decipher.update(sealed.ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/** True when at least one key is configured (for boot-time health checks). */
export function encryptionConfigured(): boolean {
  return Boolean(process.env.DATA_STUDIO_ENC_KEY || process.env.DATA_STUDIO_ENC_KEYS);
}
