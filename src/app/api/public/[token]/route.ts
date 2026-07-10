/**
 * GET /api/public/[token] — the ONLY unauthenticated data path.
 *
 * Resolves an opaque share token to its frozen `DashboardSnapshot`. It returns a
 * secret-free render shell + pre-computed result pages — never a `sourceId`,
 * table, `sql`/`ir`, or a live DB connection. Revoked/expired/unknown tokens
 * 404. Per-token rate-limited so an exposed link can't be hammered.
 */

import { NextResponse } from "next/server";
import { getShareLinkStore } from "@/lib/server/share-store";
import { rateLimit } from "@/lib/server/rate-limit";
import { clientIp, logAudit } from "@/lib/server/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  if (!rateLimit(`public:${token}`)) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  const share = await getShareLinkStore().getPublicByToken(token);
  if (!share) {
    return NextResponse.json({ error: "This link is invalid or has expired." }, { status: 404 });
  }

  // Record the anonymous view against the owning org (no actor — the token acts).
  await logAudit({
    orgId: share.orgId,
    actorUserId: null,
    action: "share.view",
    entityType: "share_link",
    entityId: share.linkId,
    ip: clientIp(req),
  });

  // No-store so a revoke takes effect immediately for the next load.
  return NextResponse.json(
    { dashboard: share.snapshot.dashboard, results: share.snapshot.results, capturedAt: share.snapshot.createdAt },
    { headers: { "Cache-Control": "no-store" } },
  );
}
