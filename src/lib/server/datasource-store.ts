/**
 * Server-side source registry — now DB-backed, encrypted, and multi-tenant.
 *
 * Holds the FULL record (public meta + secret connection config). Endpoints read
 * from it but only ever return `meta`; the secret half is sealed at rest
 * (AES-256-GCM via `lib/server/crypto`) and decrypted ONLY inside `get()`, on the
 * server, right before a connector needs it.
 *
 * Every method is scoped by `AuthContext.orgId` — a source from another org can
 * never be listed, read, updated, or removed. This replaces the earlier
 * single-tenant JSON-file store (see `scripts/migrate-datasources.ts` for the
 * one-time import of any legacy `.data/datasources.json`).
 *
 * SERVER-ONLY.
 */

import { and, asc, eq } from "drizzle-orm";
import type {
  CreateDataSourceInput,
  DataSourceKind,
  DataSourceMeta,
  DataSourceSecret,
  DataSourceStatus,
  StoredDataSource,
} from "@/lib/types/datasource";
import { db } from "@/lib/db/client";
import { dataSources } from "@/lib/db/schema";
import { open, seal } from "@/lib/server/crypto";
import { requireOrg, type AuthContext } from "@/lib/db/scope";

export interface SourceStore {
  list(ctx: AuthContext): Promise<DataSourceMeta[]>;
  get(ctx: AuthContext, id: string): Promise<StoredDataSource | undefined>;
  create(ctx: AuthContext, input: CreateDataSourceInput): Promise<DataSourceMeta>;
  update(
    ctx: AuthContext,
    id: string,
    patch: Partial<DataSourceMeta>,
  ): Promise<DataSourceMeta | undefined>;
  /** Re-seal a source's connection secret (credential rotation), org-scoped. */
  rotateSecret(
    ctx: AuthContext,
    id: string,
    input: CreateDataSourceInput,
  ): Promise<DataSourceMeta | undefined>;
  remove(ctx: AuthContext, id: string): Promise<boolean>;
}

/** Translate the client create payload into the secret + default table. */
export function secretFromInput(input: CreateDataSourceInput): {
  secret: DataSourceSecret;
  tableName?: string;
} {
  switch (input.kind) {
    case "postgres":
    case "mysql":
      return {
        secret: {
          kind: input.kind,
          host: input.host,
          port: input.port,
          database: input.database,
          user: input.user,
          password: input.password,
          ssl: input.ssl,
          table: input.table,
        },
        tableName: input.table,
      };
    case "http-file":
      return { secret: { kind: "http-file", url: input.url } };
    case "rest-api":
      return {
        secret: { kind: "rest-api", url: input.url, authToken: input.authToken },
      };
  }
}

/** A row as selected from `data_sources`. */
interface Row {
  id: string;
  name: string;
  kind: string;
  status: string;
  tableName: string | null;
  rowCount: number | null;
  error: string | null;
  secretCiphertext: Buffer | null;
  secretIv: Buffer | null;
  secretTag: Buffer | null;
  keyVersion: number | null;
}

function metaFromRow(row: Row): DataSourceMeta {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as DataSourceKind,
    status: row.status as DataSourceStatus,
    rowCount: row.rowCount ?? undefined,
    tableName: row.tableName ?? undefined,
    error: row.error ?? undefined,
  };
}

/** Postgres uuid columns reject non-uuid input; short-circuit malformed ids. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

class DbSourceStore implements SourceStore {
  async list(ctx: AuthContext): Promise<DataSourceMeta[]> {
    const rows = await db()
      .select()
      .from(dataSources)
      .where(requireOrg(dataSources.orgId, ctx))
      .orderBy(asc(dataSources.createdAt));
    return rows.map(metaFromRow);
  }

  async get(ctx: AuthContext, id: string): Promise<StoredDataSource | undefined> {
    if (!isUuid(id)) return undefined;
    const rows = await db()
      .select()
      .from(dataSources)
      .where(and(eq(dataSources.id, id), requireOrg(dataSources.orgId, ctx)))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    if (!row.secretCiphertext || !row.secretIv || !row.secretTag || row.keyVersion == null) {
      // A stored source must always carry a sealed secret; treat a missing one
      // as corruption rather than silently returning a credential-less record.
      throw new Error(`Data source ${id} is missing its encrypted secret.`);
    }
    const secret = open<DataSourceSecret>({
      ciphertext: row.secretCiphertext,
      iv: row.secretIv,
      tag: row.secretTag,
      keyVersion: row.keyVersion,
    });
    return { meta: metaFromRow(row), secret };
  }

  async create(ctx: AuthContext, input: CreateDataSourceInput): Promise<DataSourceMeta> {
    const { secret, tableName } = secretFromInput(input);
    const sealed = seal(secret);
    const [row] = await db()
      .insert(dataSources)
      .values({
        orgId: ctx.orgId,
        name: input.name,
        kind: input.kind,
        status: "idle",
        tableName: tableName ?? null,
        secretCiphertext: sealed.ciphertext,
        secretIv: sealed.iv,
        secretTag: sealed.tag,
        keyVersion: sealed.keyVersion,
        createdBy: ctx.userId,
      })
      .returning();
    return metaFromRow(row as Row);
  }

  async update(
    ctx: AuthContext,
    id: string,
    patch: Partial<DataSourceMeta>,
  ): Promise<DataSourceMeta | undefined> {
    if (!isUuid(id)) return undefined;
    // Only meta fields are patchable; id/kind/secret are immutable here.
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if ("name" in patch) set.name = patch.name;
    if ("status" in patch) set.status = patch.status;
    if ("tableName" in patch) set.tableName = patch.tableName ?? null;
    if ("rowCount" in patch) set.rowCount = patch.rowCount ?? null;
    if ("error" in patch) set.error = patch.error ?? null;

    const [row] = await db()
      .update(dataSources)
      .set(set)
      .where(and(eq(dataSources.id, id), requireOrg(dataSources.orgId, ctx)))
      .returning();
    return row ? metaFromRow(row as Row) : undefined;
  }

  async rotateSecret(
    ctx: AuthContext,
    id: string,
    input: CreateDataSourceInput,
  ): Promise<DataSourceMeta | undefined> {
    if (!isUuid(id)) return undefined;
    const { secret, tableName } = secretFromInput(input);
    const sealed = seal(secret);
    const set: Record<string, unknown> = {
      secretCiphertext: sealed.ciphertext,
      secretIv: sealed.iv,
      secretTag: sealed.tag,
      keyVersion: sealed.keyVersion,
      // A rotation may also update the name / default table + resets error state.
      name: input.name,
      status: "idle",
      error: null,
      updatedAt: new Date(),
    };
    if (tableName !== undefined) set.tableName = tableName;

    const [row] = await db()
      .update(dataSources)
      .set(set)
      .where(and(eq(dataSources.id, id), requireOrg(dataSources.orgId, ctx)))
      .returning();
    return row ? metaFromRow(row as Row) : undefined;
  }

  async remove(ctx: AuthContext, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await db()
      .delete(dataSources)
      .where(and(eq(dataSources.id, id), requireOrg(dataSources.orgId, ctx)))
      .returning({ id: dataSources.id });
    return rows.length > 0;
  }
}

const globalForStore = globalThis as unknown as { __dataStudioStore?: SourceStore };

/** The process-wide store singleton (swap the impl here to change backends). */
export function getStore(): SourceStore {
  if (!globalForStore.__dataStudioStore) {
    globalForStore.__dataStudioStore = new DbSourceStore();
  }
  return globalForStore.__dataStudioStore;
}
