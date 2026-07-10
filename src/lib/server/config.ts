/**
 * Server-side limits for pulling remote data into the browser. These are the
 * teeth behind "never attempt an unbounded table": a hard row cap and a
 * per-request timeout, both overridable via env for ops, both clamped so a
 * client-supplied `?limit=` can never exceed the cap.
 */

/** Default + maximum rows pulled into the browser in a single slice. */
export const DEFAULT_ROW_CAP = numEnv("DATA_STUDIO_ROW_CAP", 100_000);

/** Per-request query timeout (ms). */
export const QUERY_TIMEOUT_MS = numEnv("DATA_STUDIO_QUERY_TIMEOUT_MS", 30_000);

/** Clamp a requested limit into `[1, cap]`, defaulting to the cap. */
export function clampLimit(requested: number | undefined, cap = DEFAULT_ROW_CAP): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return cap;
  }
  return Math.min(Math.floor(requested), cap);
}

/** Clamp an offset to a non-negative integer. */
export function clampOffset(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return 0;
  }
  return Math.floor(requested);
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
