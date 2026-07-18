/**
 * /api/dashboards/[id]/share — share links for one dashboard (org-scoped).
 *
 *   GET  → ShareLinkMeta[] (owner list; snapshots omitted)
 *   POST → create a link, freezing the posted snapshot → ShareLinkMeta | 404
 */

import { NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth/api";
import { getShareLinkStore } from "@/lib/server/share-store";
import { errorResponse, mutationRateLimit } from "@/lib/server/api-helpers";
import { clientIp, logAudit } from "@/lib/server/audit";
import type { DashboardSnapshot } from "@/lib/types/share";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  try {
    const links = await getShareLinkStore().list(auth.ctx, id);
    return NextResponse.json(links);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const limited = mutationRateLimit(auth.ctx);
  if (limited) return limited;

  let body: { snapshot?: DashboardSnapshot; expiresAt?: string | null };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const snapshot = body.snapshot;
  if (!snapshot || typeof snapshot !== "object" || !snapshot.dashboard || !snapshot.results) {
    return NextResponse.json({ error: "A dashboard snapshot is required." }, { status: 400 });
  }

  try {
    const link = await getShareLinkStore().create(auth.ctx, id, {
      snapshot,
      expiresAt: body.expiresAt ?? null,
    });
    if (!link) return NextResponse.json({ error: "Dashboard not found." }, { status: 404 });
    await logAudit({
      orgId: auth.ctx.orgId,
      actorUserId: auth.ctx.userId,
      action: "share.create",
      entityType: "dashboard",
      entityId: id,
      metadata: { shareLinkId: link.id, mode: link.mode },
      ip: clientIp(request),
    });
    return NextResponse.json(link, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
