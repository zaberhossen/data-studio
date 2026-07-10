/**
 * One-time migration: import legacy plaintext data sources into the DB, encrypted.
 *
 * Before M2, sources lived in `.data/datasources.json` with PLAINTEXT credentials
 * and no org. This reads that file, seals each secret with the app key, and
 * inserts the rows under a target organization. After verifying, delete the
 * `.data` file (it still holds plaintext credentials).
 *
 * Usage:
 *   DATABASE_URL=... DATA_STUDIO_ENC_KEY=... \
 *     pnpm import:datasources <orgId> [path/to/datasources.json]
 *
 * The org must already exist (create an account/org via the app first, then find
 * its id). Idempotency is best-effort: re-running inserts duplicates, so run once.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/db/client";
import { dataSources, organizations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { seal } from "@/lib/server/crypto";
import type {
  DataSourceMeta,
  DataSourceSecret,
} from "@/lib/types/datasource";

interface LegacyRecord {
  meta: DataSourceMeta;
  secret: DataSourceSecret;
}

async function main() {
  const orgId = process.argv[2];
  const filePath =
    process.argv[3] ??
    process.env.DATA_STUDIO_STORE ??
    join(process.cwd(), ".data", "datasources.json");

  if (!orgId) {
    console.error("Usage: pnpm import:datasources <orgId> [path/to/datasources.json]");
    process.exit(1);
  }

  const orgRows = await db()
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!orgRows[0]) {
    console.error(`Organization ${orgId} not found. Create it first, then re-run.`);
    process.exit(1);
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    console.error(`No legacy store at ${filePath}; nothing to import.`);
    process.exit(0);
    return;
  }

  const legacy = JSON.parse(raw) as LegacyRecord[];
  if (!Array.isArray(legacy) || legacy.length === 0) {
    console.log("Legacy store is empty; nothing to import.");
    process.exit(0);
  }

  let imported = 0;
  for (const record of legacy) {
    const { secret, meta } = record;
    // `secret` is already the stored secret shape; re-seal it as-is. (We avoid
    // secretFromInput here because we have a secret, not a create payload.)
    const sealed = seal(secret);
    const tableName =
      "table" in secret && secret.table ? secret.table : meta.tableName ?? null;

    await db().insert(dataSources).values({
      orgId,
      name: meta.name,
      kind: meta.kind,
      status: "idle",
      tableName,
      secretCiphertext: sealed.ciphertext,
      secretIv: sealed.iv,
      secretTag: sealed.tag,
      keyVersion: sealed.keyVersion,
    });
    imported++;
    console.log(`  ✓ ${meta.name} (${meta.kind})`);
  }

  console.log(
    `\nImported ${imported} source(s) into org ${orgId}. ` +
      `Now DELETE ${filePath} — it still contains plaintext credentials.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
