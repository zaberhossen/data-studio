/**
 * /api/orgs/members/invites/[id] — revoke a pending invitation (admin/owner).
 *
 *   DELETE → 204 | 404
 */

import { NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth/api";
import { errorResponse, mutationRateLimit } from "@/lib/server/api-helpers";
import { getMemberStore } from "@/lib/server/member-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const limited = mutationRateLimit(auth.ctx);
  if (limited) return limited;

  try {
    const ok = await getMemberStore().revokeInvite(auth.ctx, id);
    if (!ok) return NextResponse.json({ error: "Invitation not found." }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
