/**
 * /api/orgs — the current user's org memberships (for the header workspace
 * switcher).
 *
 *   GET  → { id, name, slug, role, active }[]  — every org the signed-in user
 *          belongs to, with their role and which one is currently active.
 *   POST → { name } → { id, name, slug, role: "owner", active: false }
 *          Provisions a brand-new workspace + an `owner` membership for the
 *          caller in a single transaction. Any authenticated user may create
 *          their own workspace; switching to it happens client-side via
 *          `useSession().update({ orgId })`.
 *
 * Read-only GET is self-scoped: results are filtered by the authenticated
 * `userId`, so there is no cross-tenant leak (this lists the user's OWN
 * memberships, not any org's members). Switching the active org happens on the
 * client via `useSession().update({ orgId })` — the JWT callback in `auth.ts`
 * validates the target membership before stamping it.
 */

import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { memberships, organizations } from "@/lib/db/schema";
import { resolveAuth } from "@/lib/auth/api";
import { mutationRateLimit } from "@/lib/server/api-helpers";

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

export async function POST(req: Request) {
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const limited = mutationRateLimit(auth.ctx);
  if (limited) return limited;
  const { ctx } = auth;

  let name = "";
  try {
    const body = (await req.json()) as { name?: unknown };
    name = typeof body.name === "string" ? body.name.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ error: "Workspace name is required." }, { status: 400 });
  }
  if (name.length > 80) {
    return NextResponse.json({ error: "Workspace name is too long." }, { status: 400 });
  }

  const slug = await uniqueSlug(name);

  try {
    const org = await db().transaction(async (tx) => {
      const [created] = await tx
        .insert(organizations)
        .values({ name, slug })
        .returning({ id: organizations.id, name: organizations.name, slug: organizations.slug });
      await tx
        .insert(memberships)
        .values({ orgId: created.id, userId: ctx.userId, role: "owner" });
      return created;
    });
    return NextResponse.json(
      { ...org, role: "owner", active: false },
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ error: "Could not create the workspace." }, { status: 500 });
  }
}

/** A URL-safe, unique org slug derived from the workspace name. */
async function uniqueSlug(name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace";

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${randomSuffix()}`;
    const clash = await db()
      .select({ id: organizations.id })
      .from(organizations)
      .where(sql`${organizations.slug} = ${candidate}`)
      .limit(1);
    if (!clash[0]) return candidate;
  }
  return `${base}-${randomSuffix()}${randomSuffix()}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}
