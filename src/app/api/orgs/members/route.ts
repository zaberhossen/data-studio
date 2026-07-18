/**
 * /api/orgs/members — the caller's org members (admin/owner only).
 *
 *   GET → OrgMember[]  (org-scoped; 403 for non-admins via the store gate)
 */

import { NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth/api";
import { errorResponse } from "@/lib/server/api-helpers";
import { getMemberStore } from "@/lib/server/member-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  try {
    const members = await getMemberStore().listMembers(auth.ctx);
    return NextResponse.json(members);
  } catch (err) {
    return errorResponse(err);
  }
}
