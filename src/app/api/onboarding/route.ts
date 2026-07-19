/**
 * /api/onboarding — server-visible onboarding facts for the home checklist.
 *
 *   GET → { hasSavedQuery, hasDashboardWidget, hasShareLink }
 *
 * Org-scoped existence checks only (cheap `LIMIT 1` probes). File-upload sources
 * live only in the browser, so the "connect a source" step is judged client-side
 * from `useSources`; everything else is a durable server fact.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { savedQueries, shareLinks, widgets } from "@/lib/db/schema";
import { requireOrg } from "@/lib/db/scope";
import { resolveAuth } from "@/lib/auth/api";
import { errorResponse } from "@/lib/server/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const { ctx } = auth;

  try {
    const [savedRow, widgetRow, shareRow] = await Promise.all([
      db().select({ one: savedQueries.id }).from(savedQueries).where(requireOrg(savedQueries.orgId, ctx)).limit(1),
      db()
        .select({ one: widgets.id })
        .from(widgets)
        .where(and(requireOrg(widgets.orgId, ctx), eq(widgets.kind, "query")))
        .limit(1),
      db().select({ one: shareLinks.id }).from(shareLinks).where(requireOrg(shareLinks.orgId, ctx)).limit(1),
    ]);

    return NextResponse.json({
      hasSavedQuery: savedRow.length > 0,
      hasDashboardWidget: widgetRow.length > 0,
      hasShareLink: shareRow.length > 0,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
