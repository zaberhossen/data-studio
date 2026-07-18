/**
 * /api/orgs/members/invites — pending invitations (admin/owner only).
 *
 *   GET  → OrgInvite[]
 *   POST { email, role } → OrgInvite (201)
 */

import { NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth/api";
import { errorResponse, mutationRateLimit } from "@/lib/server/api-helpers";
import { getMemberStore } from "@/lib/server/member-store";
import { ALL_ROLES, type MemberRole } from "@/lib/types/members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  try {
    const invites = await getMemberStore().listInvites(auth.ctx);
    return NextResponse.json(invites);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const limited = mutationRateLimit(auth.ctx);
  if (limited) return limited;

  let email = "";
  let role: MemberRole = "viewer";
  try {
    const body = (await request.json()) as { email?: unknown; role?: unknown };
    if (typeof body.email === "string") email = body.email;
    if (typeof body.role === "string" && (ALL_ROLES as readonly string[]).includes(body.role)) {
      role = body.role as MemberRole;
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  try {
    const invite = await getMemberStore().createInvite(auth.ctx, email, role);
    return NextResponse.json(invite, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
