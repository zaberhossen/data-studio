/**
 * Audit log — a fire-and-forget record of security-relevant actions.
 *
 * Writes NEVER block or fail a request: `logAudit` swallows its own errors, so a
 * logging hiccup can't break sharing. Every entry is org-scoped; the actor is
 * null for unauthenticated public-share views (the token, not a user, is acting).
 *
 * SERVER-ONLY.
 */

import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";

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
