/**
 * POST /api/datasources/[id]/test — connection test → { ok, error? }.
 *
 * Opens a pooled connection and round-trips a trivial query. Errors are mapped
 * to a presentable message; raw stack traces never reach the client.
 */

import { NextResponse } from "next/server";
import type { ConnectionTestResult } from "@/lib/types/datasource";
import { getStore } from "@/lib/server/datasource-store";
import { ConnectorError, connectorFor } from "@/lib/server/connectors";
import { resolveAuth } from "@/lib/auth/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
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

  let result: ConnectionTestResult;
  try {
    const connector = connectorFor(record.meta.id, record.secret);
    await connector.test();
    result = { ok: true };
    await getStore().update(ctx, record.meta.id, { status: "ready", error: undefined });
  } catch (err) {
    const message =
      err instanceof ConnectorError
        ? err.message
        : "Connection failed. Check the host, credentials, and network access.";
    result = { ok: false, error: message };
    await getStore().update(ctx, record.meta.id, { status: "error", error: message });
  }

  return NextResponse.json(result);
}
