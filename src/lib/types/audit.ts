/**
 * Audit-log shapes shared between the server reader and the client viewer.
 *
 * Client-safe: this module carries TYPES ONLY (plus a small pure helper for the
 * keyset cursor), so a client component can import it without dragging in any
 * server-only module. The write path + DB reader live in `lib/server/audit.ts`.
 */

/** One audit entry, projected for the client (actor resolved, dates as ISO). */
export interface AuditLogRecord {
  /** Monotonic bigserial id — also the keyset pagination cursor. */
  id: number;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
  ip: string | null;
  /** ISO-8601. */
  createdAt: string;
  /** Null when the actor was an unauthenticated public-share token. */
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
}

/** A page of entries + the cursor to fetch the next (older) page, if any. */
export interface AuditLogPage {
  entries: AuditLogRecord[];
  /** Pass as `?cursor=` to get the next page; null when fully drained. */
  nextCursor: number | null;
}

/** Default / max page sizes for the list endpoint. */
export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_PAGE_MAX = 200;

export interface AuditListParams {
  limit: number;
  /** Fetch entries with id strictly less than this (older). */
  cursor: number | null;
  /** Exact-match action filter (e.g. "share.create"), or null for all. */
  action: string | null;
}

/**
 * Parse the raw `URLSearchParams` of the list endpoint into validated params.
 * Pure + total: bad/absent values fall back to safe defaults, `limit` is clamped
 * to `[1, AUDIT_PAGE_MAX]`, and a non-positive/NaN cursor becomes null (page 1).
 */
export function parseAuditListParams(search: URLSearchParams): AuditListParams {
  const rawLimit = Number(search.get("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), AUDIT_PAGE_MAX)
      : AUDIT_PAGE_SIZE;

  const rawCursor = Number(search.get("cursor"));
  const cursor =
    Number.isFinite(rawCursor) && rawCursor > 0 ? Math.floor(rawCursor) : null;

  const rawAction = search.get("action");
  const action = rawAction && rawAction.trim() ? rawAction.trim() : null;

  return { limit, cursor, action };
}
