/**
 * /api/dashboards — collection endpoint (org-scoped).
 *
 *   GET  → DashboardSummary[]  ({ id, name, updatedAt, layoutMode }, most-recent first)
 *   POST → create an empty dashboard from { name?, layoutMode? } → Dashboard (201)
 */

import { NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth/api";
import { getDashboardDbStore } from "@/lib/server/dashboard-store";
import { errorResponse, mutationRateLimit } from "@/lib/server/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const list = await getDashboardDbStore().list(auth.ctx);
  return NextResponse.json(list);
}

export async function POST(request: Request) {
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const limited = mutationRateLimit(auth.ctx);
  if (limited) return limited;

  let name = "Untitled dashboard";
  let layoutMode: "grid" | "canvas" = "grid";
  try {
    const b = (await request.json()) as { name?: unknown; layoutMode?: unknown };
    if (typeof b.name === "string" && b.name.trim()) name = b.name.trim();
    if (b.layoutMode === "canvas") layoutMode = "canvas";
  } catch {
    // empty body is fine — a default-named grid dashboard
  }

  try {
    const created = await getDashboardDbStore().create(auth.ctx, name, layoutMode);
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
