/**
 * /api/saved-queries/[id] — item endpoint (org-scoped).
 *
 *   GET    → SavedQuery | 404
 *   PATCH  → update (definition and/or name/description) → SavedQuery | 404
 *   DELETE → 204
 */

import { NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth/api";
import { getSavedQueryDbStore } from "@/lib/server/saved-query-store";
import type { SavedQueryPatch } from "@/lib/saved-queries/store";
import { errorResponse, mutationRateLimit } from "@/lib/server/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const found = await getSavedQueryDbStore().get(auth.ctx, id);
  if (!found) return NextResponse.json({ error: "Saved query not found." }, { status: 404 });
  return NextResponse.json(found);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const limited = mutationRateLimit(auth.ctx);
  if (limited) return limited;

  let patch: SavedQueryPatch;
  try {
    patch = (await request.json()) as SavedQueryPatch;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const updated = await getSavedQueryDbStore().update(auth.ctx, id, patch);
    if (!updated) return NextResponse.json({ error: "Saved query not found." }, { status: 404 });
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
    await getSavedQueryDbStore().remove(auth.ctx, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
