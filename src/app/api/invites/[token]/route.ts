/**
 * /api/invites/[token] — resolve / accept an invitation by its opaque token.
 *
 *   GET  → InvitePreview  (UNAUTHENTICATED — the token is the capability; leaks
 *          nothing beyond org name, invited email, and role)
 *   POST → { orgId }      (AUTHENTICATED accept; the caller's email must match
 *          the invited address). The client then switches into `orgId`.
 */

import { NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth/api";
import { errorResponse, mutationRateLimit } from "@/lib/server/api-helpers";
import { getMemberStore } from "@/lib/server/member-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const preview = await getMemberStore().getInviteByToken(token);
    return NextResponse.json(preview, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const limited = mutationRateLimit(auth.ctx);
  if (limited) return limited;

  try {
    const result = await getMemberStore().acceptInvite(auth.ctx, token);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
