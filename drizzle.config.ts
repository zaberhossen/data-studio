import { readFileSync } from "node:fs";
import type { Config } from "drizzle-kit";

/**
 * Drizzle Kit config for the application database (our metadata store).
 *
 *   pnpm db:generate   → emit SQL migrations from schema.ts changes
 *   pnpm db:migrate    → apply pending migrations to DATABASE_URL
 *   pnpm db:push       → sync schema straight to the DB (dev only)
 *   pnpm db:studio     → open Drizzle Studio
 *
 * `generate` reads only schema.ts and needs no DB connection; `migrate`/`push`/
 * `studio` require DATABASE_URL.
 *
 * The drizzle-kit CLI (unlike Next.js) does NOT auto-read `.env.local`, so we
 * load it (then `.env`) here — existing shell vars always win, and nothing is
 * hardcoded.
 */
for (const file of [".env.local", ".env"]) {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[m[1]] = value;
    }
  } catch {
    /* file absent — fall through to shell env */
  }
}
export default {
  schema: "./src/lib/db/schema.ts",
  out: "./src/lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
} satisfies Config;
