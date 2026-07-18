/**
 * /api/dashboards/[id] — item endpoint (org-scoped).
 *
 *   GET    → Dashboard (reassembled head + widgets) | 404
 *   PUT    → overwrite (decompose head + widgets in a txn) → Dashboard | 404
 *   PATCH  → rename only ({ name }) → Dashboard | 404
 *   DELETE → 204 (widgets cascade)
 */

import { NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth/api";
import { getDashboardDbStore } from "@/lib/server/dashboard-store";
import type { Dashboard } from "@/lib/types/dashboard";
import { errorResponse, mutationRateLimit } from "@/lib/server/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const found = await getDashboardDbStore().get(auth.ctx, id);
  if (!found) return NextResponse.json({ error: "Dashboard not found." }, { status: 404 });
  return NextResponse.json(found);
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  // Autosave hot path (debounced full save) — a higher ceiling avoids false trips.
  const limited = mutationRateLimit(auth.ctx, 600);
  if (limited) return limited;

  let body: Dashboard;
  try {
    body = (await request.json()) as Dashboard;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.widgets)) {
    return NextResponse.json({ error: "A dashboard with a widgets array is required." }, { status: 400 });
  }

  try {
    // The URL id is authoritative — the body can't retarget another dashboard.
    // A numeric `version` engages the optimistic lock; its absence forces a save.
    const expectedVersion = typeof body.version === "number" ? body.version : undefined;
    const saved = await getDashboardDbStore().save(auth.ctx, { ...body, id }, expectedVersion);
    if (!saved) return NextResponse.json({ error: "Dashboard not found." }, { status: 404 });
    return NextResponse.json(saved);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const limited = mutationRateLimit(auth.ctx);
  if (limited) return limited;

  let name = "";
  try {
    const b = (await request.json()) as { name?: unknown };
    name = typeof b.name === "string" ? b.name.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!name) return NextResponse.json({ error: "A name is required." }, { status: 400 });

  try {
    const store = getDashboardDbStore();
    const current = await store.get(auth.ctx, id);
    if (!current) return NextResponse.json({ error: "Dashboard not found." }, { status: 404 });
    const saved = await store.save(auth.ctx, { ...current, name });
    if (!saved) return NextResponse.json({ error: "Dashboard not found." }, { status: 404 });
    return NextResponse.json(saved);
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
    await getDashboardDbStore().remove(auth.ctx, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
