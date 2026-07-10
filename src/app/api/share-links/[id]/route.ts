/**
 * /api/share-links/[id] — revoke a share link (org-scoped, soft-delete).
 *
 *   DELETE → 204 | 404
 */

import { NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth/api";
import { getShareLinkStore } from "@/lib/server/share-store";
import { errorResponse } from "@/lib/server/api-helpers";
import { clientIp, logAudit } from "@/lib/server/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  try {
    const ok = await getShareLinkStore().revoke(auth.ctx, id);
    if (!ok) return NextResponse.json({ error: "Share link not found." }, { status: 404 });
    await logAudit({
      orgId: auth.ctx.orgId,
      actorUserId: auth.ctx.userId,
      action: "share.revoke",
      entityType: "share_link",
      entityId: id,
      ip: clientIp(_req),
    });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
