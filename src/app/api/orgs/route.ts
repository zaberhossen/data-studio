/**
 * /api/orgs — the current user's org memberships (for the header workspace
 * switcher).
 *
 *   GET → { id, name, slug, role, active }[]  — every org the signed-in user
 *          belongs to, with their role and which one is currently active.
 *
 * Read-only and self-scoped: results are filtered by the authenticated
 * `userId`, so there is no cross-tenant leak (this lists the user's OWN
 * memberships, not any org's members). Switching the active org happens on the
 * client via `useSession().update({ orgId })` — the JWT callback in `auth.ts`
 * validates the target membership before stamping it.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { memberships, organizations } from "@/lib/db/schema";
import { resolveAuth } from "@/lib/auth/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const { ctx } = auth;

  const rows = await db()
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.orgId, organizations.id))
    .where(eq(memberships.userId, ctx.userId));

  const orgs = rows.map((o: (typeof rows)[number]) => ({
    ...o,
    active: o.id === ctx.orgId,
  }));
  return NextResponse.json(orgs);
}
