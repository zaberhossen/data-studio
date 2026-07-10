/**
 * /api/dashboards — collection endpoint (org-scoped).
 *
 *   GET  → DashboardSummary[]  ({ id, name, updatedAt }, most-recent first)
 *   POST → create an empty dashboard from { name? } → Dashboard (201)
 */

import { NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth/api";
import { getDashboardDbStore } from "@/lib/server/dashboard-store";
import { errorResponse } from "@/lib/server/api-helpers";

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

  let name = "Untitled dashboard";
  try {
    const b = (await request.json()) as { name?: unknown };
    if (typeof b.name === "string" && b.name.trim()) name = b.name.trim();
  } catch {
    // empty body is fine — a default-named dashboard
  }

  try {
    const created = await getDashboardDbStore().create(auth.ctx, name);
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
