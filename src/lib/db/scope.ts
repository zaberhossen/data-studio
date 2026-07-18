/**
 * Multi-tenant scoping.
 *
 * Cross-tenant access is prevented by construction: every tenant table carries
 * an `orgId`, and every store method takes an `AuthContext` and ANDs
 * `eq(table.orgId, ctx.orgId)` into its `WHERE`. A row from another org simply
 * never matches — there is no code path that can read or write across orgs.
 *
 * Use `requireOrg(table, ctx)` in every query as the first `where` clause and
 * combine further predicates with `and(...)`. Keeping the pattern in one place
 * makes the invariant auditable (grep for `requireOrg`).
 *
 * SERVER-ONLY.
 */

import { eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export type MemberRole = "owner" | "admin" | "editor" | "viewer";

/**
 * The authenticated caller + their active org. Produced by
 * `requireAuthContext()` (added in the auth milestone, M1) and threaded into
 * every store method. Until M1 wires real sessions, callers construct it from
 * the resolved session.
 */
export interface AuthContext {
  userId: string;
  orgId: string;
  role: MemberRole;
}

/** Roles allowed to mutate (create/update/delete) tenant entities. */
const WRITE_ROLES: ReadonlySet<MemberRole> = new Set(["owner", "admin", "editor"]);

/** Roles allowed to administer the org (audit log, member/role management, …). */
const ADMIN_ROLES: ReadonlySet<MemberRole> = new Set(["owner", "admin"]);

export function canWrite(ctx: AuthContext): boolean {
  return WRITE_ROLES.has(ctx.role);
}

/** Throw a 403-shaped error when the caller lacks write permission. */
export function assertCanWrite(ctx: AuthContext): void {
  if (!canWrite(ctx)) {
    throw new ForbiddenError(`Role "${ctx.role}" cannot modify this resource.`);
  }
}

export function canAdmin(ctx: AuthContext): boolean {
  return ADMIN_ROLES.has(ctx.role);
}

/** Throw a 403-shaped error when the caller isn't an org admin/owner. */
export function assertCanAdmin(ctx: AuthContext): void {
  if (!canAdmin(ctx)) {
    throw new ForbiddenError(`Role "${ctx.role}" cannot access this resource.`);
  }
}

/**
 * The mandatory tenant predicate. Pass the table's `orgId` column and the
 * caller's context; the result is `eq(orgIdColumn, ctx.orgId)`, to be used as
 * the first `where` clause (combine with `and()` for more predicates).
 */
export function requireOrg(orgIdColumn: PgColumn, ctx: AuthContext): SQL {
  return eq(orgIdColumn, ctx.orgId);
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}
