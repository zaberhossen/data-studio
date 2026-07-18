/**
 * Audit log — a fire-and-forget record of security-relevant actions.
 *
 * Writes NEVER block or fail a request: `logAudit` swallows its own errors, so a
 * logging hiccup can't break sharing. Every entry is org-scoped; the actor is
 * null for unauthenticated public-share views (the token, not a user, is acting).
 *
 * SERVER-ONLY.
 */

import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, users } from "@/lib/db/schema";
import { assertCanAdmin, requireOrg, type AuthContext } from "@/lib/db/scope";
import type {
  AuditListParams,
  AuditLogPage,
  AuditLogRecord,
} from "@/lib/types/audit";

export interface AuditEntry {
  orgId: string;
  /** Null for unauthenticated (public token) actions. */
  actorUserId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: unknown;
  ip?: string | null;
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await db()
      .insert(auditLog)
      .values({
        orgId: entry.orgId,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        metadata: (entry.metadata ?? null) as never,
        ip: entry.ip ?? null,
      });
  } catch {
    /* auditing is best-effort; never surface to the caller */
  }
}

/** Best-effort client IP from proxy headers (first hop in X-Forwarded-For). */
export function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip");
}

/**
 * Read a page of audit entries for the caller's org, newest first.
 *
 * Admin/owner only (`assertCanAdmin`) — the log records security-relevant
 * actions across the whole org, so it isn't for editors/viewers. Org-scoped via
 * `requireOrg`, so an admin can never read another tenant's log. Pagination is
 * keyset on the monotonic bigserial `id` (id desc ≈ createdAt desc, but stable
 * under ties and index-friendly): each page returns `nextCursor` = the last
 * row's id, and the next call filters `id < cursor`. Actor name/email are joined
 * from `users` (left join — actor is null for public-share-token views).
 */
export async function listAudit(
  ctx: AuthContext,
  params: AuditListParams,
): Promise<AuditLogPage> {
  assertCanAdmin(ctx);

  const conditions = [requireOrg(auditLog.orgId, ctx)];
  if (params.cursor !== null) conditions.push(lt(auditLog.id, params.cursor));
  if (params.action !== null) conditions.push(eq(auditLog.action, params.action));

  const rows = await db()
    .select({
      id: auditLog.id,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      metadata: auditLog.metadata,
      ip: auditLog.ip,
      createdAt: auditLog.createdAt,
      actorUserId: auditLog.actorUserId,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorUserId, users.id))
    .where(and(...conditions))
    .orderBy(desc(auditLog.id))
    .limit(params.limit + 1);

  // Fetch one extra to know whether an older page exists without a count query.
  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;

  const entries: AuditLogRecord[] = page.map((r) => ({
    id: r.id,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    metadata: r.metadata ?? null,
    ip: r.ip,
    createdAt: r.createdAt.toISOString(),
    actorUserId: r.actorUserId,
    actorName: r.actorName ?? null,
    actorEmail: r.actorEmail ?? null,
  }));

  const nextCursor = hasMore ? entries[entries.length - 1]!.id : null;
  return { entries, nextCursor };
}

/** Distinct action strings present in the caller's org log (for filter chips). */
export async function listAuditActions(ctx: AuthContext): Promise<string[]> {
  assertCanAdmin(ctx);
  const rows = await db()
    .selectDistinct({ action: auditLog.action })
    .from(auditLog)
    .where(requireOrg(auditLog.orgId, ctx))
    .orderBy(auditLog.action);
  return rows.map((r) => r.action);
}
