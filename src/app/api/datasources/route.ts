/**
 * /api/datasources — collection endpoint.
 *
 *   GET  → DataSourceMeta[]  (secret-free; safe to ship to the browser)
 *   POST → create a source from a connection config (password accepted ONCE,
 *          stored server-side, NEVER echoed back) → responds with meta only.
 *
 * This route is the browser/server boundary: it is the only place credentials
 * are accepted, and they go straight into the server-side store.
 */

import { NextResponse } from "next/server";
import type { CreateDataSourceInput } from "@/lib/types/datasource";
import { getStore } from "@/lib/server/datasource-store";
import { resolveAuth } from "@/lib/auth/api";
import { assertCanWrite } from "@/lib/db/scope";
import { mutationRateLimit } from "@/lib/server/api-helpers";

// Connectors use Node APIs (net/tls via pg) — force the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;

  const sources = await getStore().list(auth.ctx);
  return NextResponse.json(sources);
}

export async function POST(request: Request) {
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const limited = mutationRateLimit(auth.ctx);
  if (limited) return limited;

  try {
    assertCanWrite(auth.ctx);
  } catch {
    return NextResponse.json(
      { error: "You don't have permission to add data sources." },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const validation = validateCreate(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const meta = await getStore().create(auth.ctx, validation.input);
  // Echo meta ONLY — the password the client just sent is now server-side.
  return NextResponse.json(meta, { status: 201 });
}

// ---------------------------------------------------------------------------
// Minimal, dependency-free validation of the create payload.
// ---------------------------------------------------------------------------

type Validated =
  | { ok: true; input: CreateDataSourceInput }
  | { ok: false; error: string };

function validateCreate(body: unknown): Validated {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Body must be an object." };
  }
  const b = body as Record<string, unknown>;
  const kind = b.kind;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return { ok: false, error: "A source name is required." };

  switch (kind) {
    case "postgres":
    case "mysql": {
      const host = str(b.host);
      const database = str(b.database);
      const user = str(b.user);
      const password = typeof b.password === "string" ? b.password : "";
      const port = Number(b.port);
      if (!host) return { ok: false, error: "Host is required." };
      if (!database) return { ok: false, error: "Database is required." };
      if (!user) return { ok: false, error: "User is required." };
      if (!Number.isFinite(port) || port <= 0) {
        return { ok: false, error: "A valid port is required." };
      }
      return {
        ok: true,
        input: {
          kind,
          name,
          host,
          port,
          database,
          user,
          password,
          table: str(b.table) || undefined,
          ssl: b.ssl === true,
        },
      };
    }
    case "http-file": {
      const url = str(b.url);
      if (!isHttpUrl(url)) return { ok: false, error: "A valid http(s) URL is required." };
      return { ok: true, input: { kind, name, url } };
    }
    case "rest-api": {
      const url = str(b.url);
      if (!isHttpUrl(url)) return { ok: false, error: "A valid http(s) URL is required." };
      return {
        ok: true,
        input: {
          kind,
          name,
          url,
          authToken: typeof b.authToken === "string" && b.authToken ? b.authToken : undefined,
        },
      };
    }
    default:
      return { ok: false, error: `Unsupported source kind: ${String(kind)}` };
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
