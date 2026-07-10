/**
 * GET /api/datasources/[id]/schema — introspect the source → SourceSchema.
 *
 * `tables` is the allowlist the data endpoint validates `?table=` against, and
 * `columns` drives the UI field browser. Pure metadata — no rows, no secrets.
 */

import { NextResponse } from "next/server";
import { getStore } from "@/lib/server/datasource-store";
import { ConnectorError, connectorFor } from "@/lib/server/connectors";
import { resolveAuth } from "@/lib/auth/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const { ctx } = auth;

  const record = await getStore().get(ctx, id);
  if (!record) {
    return NextResponse.json({ error: "Source not found." }, { status: 404 });
  }

  try {
    const connector = connectorFor(record.meta.id, record.secret);
    const schema = await connector.introspectSchema();
    return NextResponse.json(schema);
  } catch (err) {
    const message =
      err instanceof ConnectorError
        ? err.message
        : "Failed to read the source schema.";
    await getStore().update(ctx, record.meta.id, { status: "error", error: message });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
