/**
 * Server-side saved-query store (Postgres / Drizzle) — the DB backing behind
 * `/api/saved-queries`. Mirrors `datasource-store.ts`: every method takes an
 * `AuthContext` and ANDs `requireOrg(...)` into its query, so a record from
 * another org can never be read, listed, updated, or deleted. Writes also
 * require an editor+ role (`assertCanWrite`).
 *
 * The full `QueryDefinition` lives in the `definition` jsonb column; the
 * authoritative `sourceId` (which may be a non-UUID like the demo/file ids)
 * lives inside it, so the FK `source_id` column is intentionally left null.
 *
 * SERVER-ONLY.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { savedQueries } from "@/lib/db/schema";
import { assertCanWrite, requireOrg, type AuthContext } from "@/lib/db/scope";
import type { QueryDefinition, SavedQuery } from "@/lib/types/query";
import { SAVED_QUERY_SCHEMA_VERSION } from "@/lib/types/query";
import type { SavedQueryPatch, SavedQuerySummary } from "@/lib/saved-queries/store";

/** UUID guard — a malformed id must yield "not found", not a Postgres cast error. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}

type Row = typeof savedQueries.$inferSelect;

function rowToSaved(r: Row): SavedQuery {
  return {
    ...(r.definition as QueryDefinition),
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    schemaVersion: r.schemaVersion,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function rowToSummary(r: Row): SavedQuerySummary {
  const def = r.definition as QueryDefinition;
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    sourceId: def.sourceId,
    queryKind: def.queryKind,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Keep only the definition-shaped fields off an arbitrary patch. */
function definitionPatch(patch: SavedQueryPatch): Partial<QueryDefinition> {
  const out: Partial<QueryDefinition> = {};
  if (patch.sourceId !== undefined) out.sourceId = patch.sourceId;
  if (patch.queryKind !== undefined) out.queryKind = patch.queryKind;
  if (patch.query !== undefined) out.query = patch.query;
  if (patch.ir !== undefined) out.ir = patch.ir;
  if (patch.sql !== undefined) out.sql = patch.sql;
  if (patch.execution !== undefined) out.execution = patch.execution;
  if (patch.viz !== undefined) out.viz = patch.viz;
  return out;
}

export class DbSavedQueryStore {
  async list(ctx: AuthContext): Promise<SavedQuerySummary[]> {
    const rows = await db()
      .select()
      .from(savedQueries)
      .where(requireOrg(savedQueries.orgId, ctx))
      .orderBy(desc(savedQueries.updatedAt));
    return rows.map(rowToSummary);
  }

  async get(ctx: AuthContext, id: string): Promise<SavedQuery | null> {
    if (!isUuid(id)) return null;
    const [row] = await db()
      .select()
      .from(savedQueries)
      .where(and(requireOrg(savedQueries.orgId, ctx), eq(savedQueries.id, id)))
      .limit(1);
    return row ? rowToSaved(row) : null;
  }

  async create(
    ctx: AuthContext,
    def: QueryDefinition,
    name: string,
    description?: string,
  ): Promise<SavedQuery> {
    assertCanWrite(ctx);
    const [row] = await db()
      .insert(savedQueries)
      .values({
        orgId: ctx.orgId,
        name,
        description: description?.trim() ? description.trim() : null,
        definition: def,
        schemaVersion: SAVED_QUERY_SCHEMA_VERSION,
        createdBy: ctx.userId,
      })
      .returning();
    return rowToSaved(row);
  }

  async update(
    ctx: AuthContext,
    id: string,
    patch: SavedQueryPatch,
  ): Promise<SavedQuery | null> {
    assertCanWrite(ctx);
    if (!isUuid(id)) return null;
    const existing = await this.get(ctx, id);
    if (!existing) return null;

    const nextDefinition: QueryDefinition = {
      sourceId: existing.sourceId,
      queryKind: existing.queryKind,
      query: existing.query,
      ir: existing.ir,
      sql: existing.sql,
      execution: existing.execution,
      viz: existing.viz,
      ...definitionPatch(patch),
    };

    const [row] = await db()
      .update(savedQueries)
      .set({
        definition: nextDefinition,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description?.trim() ? patch.description.trim() : null }
          : {}),
        schemaVersion: SAVED_QUERY_SCHEMA_VERSION,
        updatedAt: new Date(),
      })
      .where(and(requireOrg(savedQueries.orgId, ctx), eq(savedQueries.id, id)))
      .returning();
    return row ? rowToSaved(row) : null;
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    assertCanWrite(ctx);
    if (!isUuid(id)) return;
    await db()
      .delete(savedQueries)
      .where(and(requireOrg(savedQueries.orgId, ctx), eq(savedQueries.id, id)));
  }
}

let store: DbSavedQueryStore | null = null;
export function getSavedQueryDbStore(): DbSavedQueryStore {
  if (!store) store = new DbSavedQueryStore();
  return store;
}
