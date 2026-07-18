/**
 * /api/audit-log — read the org's security audit log (admin/owner only).
 *
 *   GET ?limit&cursor&action → AuditLogPage  ({ entries, nextCursor }, newest first)
 *   GET ?actions=1           → string[]      (distinct actions, for filter chips)
 *
 * Org-scoped + admin-gated inside the store (`listAudit`/`listAuditActions` call
 * `assertCanAdmin`), so a non-admin gets a clean 403 via `errorResponse`.
 */

import { NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth/api";
import { errorResponse } from "@/lib/server/api-helpers";
import { listAudit, listAuditActions } from "@/lib/server/audit";
import { parseAuditListParams } from "@/lib/types/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;

  const search = new URL(request.url).searchParams;
  try {
    if (search.get("actions")) {
      const actions = await listAuditActions(auth.ctx);
      return NextResponse.json({ actions });
    }
    const page = await listAudit(auth.ctx, parseAuditListParams(search));
    return NextResponse.json(page);
  } catch (err) {
    return errorResponse(err);
  }
}
