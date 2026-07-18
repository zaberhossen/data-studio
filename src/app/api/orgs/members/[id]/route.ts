/**
 * /api/orgs/members/[id] — change a member's role or remove them (admin/owner).
 *
 *   PATCH { role } → OrgMember | 404
 *   DELETE         → 204 | 404
 *
 * `id` is the membership id. All guards (self, last-owner, admin-vs-owner) live
 * in the store and surface as typed 400/403 responses via `errorResponse`.
 */

import { NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth/api";
import { errorResponse, mutationRateLimit } from "@/lib/server/api-helpers";
import { getMemberStore } from "@/lib/server/member-store";
import { ALL_ROLES, type MemberRole } from "@/lib/types/members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const limited = mutationRateLimit(auth.ctx);
  if (limited) return limited;

  let role: MemberRole | null = null;
  try {
    const body = (await request.json()) as { role?: unknown };
    if (typeof body.role === "string" && (ALL_ROLES as readonly string[]).includes(body.role)) {
      role = body.role as MemberRole;
    }
  } catch {
    /* fall through to validation below */
  }
  if (!role) return NextResponse.json({ error: "A valid role is required." }, { status: 400 });

  try {
    const updated = await getMemberStore().changeRole(auth.ctx, id, role);
    if (!updated) return NextResponse.json({ error: "Member not found." }, { status: 404 });
    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const limited = mutationRateLimit(auth.ctx);
  if (limited) return limited;

  try {
    const ok = await getMemberStore().removeMember(auth.ctx, id);
    if (!ok) return NextResponse.json({ error: "Member not found." }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
