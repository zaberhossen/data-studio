/**
 * Server-side share-link store (Postgres / Drizzle).
 *
 * Owner-facing methods (`create`/`list`/`revoke`) are org-scoped + require an
 * editor role, exactly like every other tenant store. `getPublicByToken` is the
 * ONLY unauthenticated path: it is keyed solely by the opaque, unguessable token
 * and returns the frozen snapshot, rejecting revoked/expired links. It never
 * touches org scoping because the token IS the capability.
 *
 * SERVER-ONLY.
 */

import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { dashboards, shareLinks } from "@/lib/db/schema";
import { assertCanWrite, requireOrg, type AuthContext } from "@/lib/db/scope";
import type {
  DashboardSnapshot,
  ShareLinkMeta,
  SharePermission,
  ShareMode,
} from "@/lib/types/share";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (id: string) => UUID_RE.test(id);

/** An opaque, URL-safe token (192 bits) — unguessable + independent of the id. */
function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function rowToMeta(r: typeof shareLinks.$inferSelect): ShareLinkMeta {
  return {
    id: r.id,
    token: r.token,
    permission: r.permission as SharePermission,
    mode: r.mode as ShareMode,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

export interface CreateShareInput {
  permission?: SharePermission;
  mode?: ShareMode;
  /** ISO string or null (never expires). */
  expiresAt?: string | null;
  snapshot: DashboardSnapshot;
}

/** What a valid public token resolves to (nothing identifying beyond the shell). */
export interface PublicShare {
  snapshot: DashboardSnapshot;
  permission: SharePermission;
  mode: ShareMode;
  /** Owning org + link id — used only server-side for audit logging. */
  orgId: string;
  linkId: string;
}

export class DbShareLinkStore {
  /** Create a link for a dashboard the caller owns, freezing `snapshot`. */
  async create(ctx: AuthContext, dashboardId: string, input: CreateShareInput): Promise<ShareLinkMeta | null> {
    assertCanWrite(ctx);
    if (!isUuid(dashboardId)) return null;

    // The dashboard must exist in the caller's org — never share across tenants.
    const [owner] = await db()
      .select({ id: dashboards.id })
      .from(dashboards)
      .where(and(requireOrg(dashboards.orgId, ctx), eq(dashboards.id, dashboardId)))
      .limit(1);
    if (!owner) return null;

    const [row] = await db()
      .insert(shareLinks)
      .values({
        orgId: ctx.orgId,
        dashboardId,
        token: newToken(),
        permission: input.permission ?? "view",
        mode: input.mode ?? "link",
        snapshot: input.snapshot,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdBy: ctx.userId,
      })
      .returning();
    return rowToMeta(row);
  }

  /** List a dashboard's links (owner view — snapshot omitted). */
  async list(ctx: AuthContext, dashboardId: string): Promise<ShareLinkMeta[]> {
    if (!isUuid(dashboardId)) return [];
    const rows = await db()
      .select()
      .from(shareLinks)
      .where(and(requireOrg(shareLinks.orgId, ctx), eq(shareLinks.dashboardId, dashboardId)))
      .orderBy(desc(shareLinks.createdAt));
    return rows.map(rowToMeta);
  }

  /** Soft-revoke a link (kept for audit); org-scoped. */
  async revoke(ctx: AuthContext, id: string): Promise<boolean> {
    assertCanWrite(ctx);
    if (!isUuid(id)) return false;
    const rows = await db()
      .update(shareLinks)
      .set({ revokedAt: new Date() })
      .where(and(requireOrg(shareLinks.orgId, ctx), eq(shareLinks.id, id)))
      .returning({ id: shareLinks.id });
    return rows.length > 0;
  }

  /**
   * Resolve an opaque token to its snapshot. UNAUTHENTICATED — the token is the
   * capability. Returns null for unknown / revoked / expired links.
   */
  async getPublicByToken(token: string, now: Date = new Date()): Promise<PublicShare | null> {
    if (!token || token.length < 16) return null;
    const [row] = await db()
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.token, token))
      .limit(1);
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
    if (!row.snapshot) return null;
    return {
      snapshot: row.snapshot,
      permission: row.permission as SharePermission,
      mode: row.mode as ShareMode,
      orgId: row.orgId,
      linkId: row.id,
    };
  }
}

let store: DbShareLinkStore | null = null;
export function getShareLinkStore(): DbShareLinkStore {
  if (!store) store = new DbShareLinkStore();
  return store;
}
