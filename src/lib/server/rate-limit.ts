/**
 * Best-effort per-key rate limiter (fixed window, in-memory).
 *
 * Bounds abuse of the unauthenticated public-share endpoint. NOTE: state is
 * per-process — behind multiple instances each enforces its own window, so this
 * is a first line of defense, not a hard global quota (a shared store like Redis
 * would make it global; out of scope here).
 *
 * SERVER-ONLY.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;

const buckets = new Map<string, Bucket>();

/**
 * Returns true when the request is allowed. `now` is injectable for tests.
 * Sweeps expired buckets opportunistically so the map can't grow unbounded.
 */
export function rateLimit(
  key: string,
  now: number = Date.now(),
  max: number = MAX_PER_WINDOW,
  windowMs: number = WINDOW_MS,
): boolean {
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 10_000) sweep(now);
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

function sweep(now: number): void {
  for (const [key, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(key);
  }
}

/** Test hook — clear all windows. */
export function __resetRateLimit(): void {
  buckets.clear();
}
