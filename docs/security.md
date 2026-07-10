# Security Model

The security rules are non-negotiable and enforced in code, not just by
convention. This doc is the checklist plus where each rule lives.

---

## 1. Credentials never reach the client

- Connection secrets are stored **server-side only** — in the source store
  ([`datasource-store.ts`](../src/lib/server/datasource-store.ts)), as
  `StoredDataSource = { meta, secret }`.
- **Encrypted at rest (M2):** the store is now Postgres-backed and each secret is
  sealed with **AES-256-GCM** ([`crypto.ts`](../src/lib/server/crypto.ts)) before
  it touches the DB; it is decrypted only inside `DbSourceStore.get()`, on the
  server, right before a connector needs it. The key comes from
  `DATA_STUDIO_ENC_KEY` and is versioned (`key_version`) for rotation.
- The client-facing types are split from the secret-bearing types by an explicit
  **SERVER-ONLY** banner in [`types/datasource.ts`](../src/lib/types/datasource.ts).
  `DataSourceMeta` is secret-free by construction.
- A password/token is accepted **once** over HTTPS by `POST /api/datasources` and
  then never echoed. Every endpoint returns **meta only**.
- Nothing under [`src/lib/server/`](../src/lib/server/) is imported by a client
  component or worker, so secrets can't be bundled into client JS.

## 2. The browser can't send arbitrary SQL to a remote database

- The data endpoint pulls a **bounded slice of a validated table/view** with
  `limit`/`offset` only — it never accepts SQL for the remote DB.
- Arbitrary SQL runs **in-browser** against DuckDB over already-loaded data (a
  separate, sandboxed path), never against the source connection.
- **Pushdown (M5):** `POST /api/datasources/[id]/run` accepts a **`QueryIR`,
  never SQL**. The server re-introspects the schema to build the column
  allowlist, forces the query's table to the source's configured table (ignoring
  any client value), and compiles the IR itself
  ([`compileIR`](../src/lib/query/compile/compile.ts)) — a tampered IR (out-of-
  allowlist column) is rejected with a 400. Only that server-built, parameterized
  SQL — wrapped in a `LIMIT` envelope under the statement timeout via
  `connector.runCompiled` — ever reaches the customer database.
- **Client wiring (M5b):** the browser never posts the IR from the main thread —
  the DuckDB worker does (a `run_pushdown` message → `POST /run` →
  [`sql.worker.ts`](../src/workers/sql.worker.ts)). The Arrow result is ingested as
  its own worker-side dataset and read back only page-by-page, so the pushdown
  rows honor the same "React never holds raw rows" invariant as every other path.

## 3. Parameterized queries + table allowlisting

- `introspectSchema()` builds an **allowlist** of selectable tables.
- `fetchRows()` **rejects any table not on the allowlist**, then quotes the
  validated identifier (`pg.escapeIdentifier` for Postgres; doubled-backtick for
  MySQL) and binds `LIMIT`/`OFFSET` as parameters. No client string is ever
  interpolated into SQL text.
  ([`connectors/postgres.ts`](../src/lib/server/connectors/postgres.ts),
  [`connectors/mysql.ts`](../src/lib/server/connectors/mysql.ts))

## 4. Bounded pulls — no unbounded tables

- A hard **row cap** (default 100k) and a **per-request timeout** (30s) apply to
  every server pull ([`config.ts`](../src/lib/server/config.ts)). Both are
  env-overridable; a client-supplied `?limit=` is clamped to the cap.
- The connector also sets `statement_timeout` on every connection as
  belt-and-braces, and probes `limit + 1` rows to report truncation (`capped`).

## 5. Connection pooling

- One pool per source id (`pg.Pool` / mysql2 pool), cached on `globalThis`
  (survives dev HMR), with bounded `max`, idle timeout, and connection timeout.
  Deleting a source disposes its pool.

## 5a. Tenant isolation (M2)

- Every data-source row carries an `org_id`; every store method takes an
  `AuthContext` and ANDs `requireOrg(...)` into its query
  ([`scope.ts`](../src/lib/db/scope.ts)), so a source from another org can't be
  listed, read, tested, or deleted. API routes self-authenticate via
  `resolveAuth` ([`api.ts`](../src/lib/auth/api.ts)) — an unauthenticated fetch
  gets a JSON 401, not a login redirect. Writes (create/delete) also require an
  editor+ role (`assertCanWrite`).

## 6. Read-only SQL guard (DuckDB worker)

- The DuckDB worker only runs a **single** `SELECT` / `WITH` statement; a large
  forbidden-keyword denylist blocks `INSERT/UPDATE/DELETE/DROP/ATTACH/COPY/…`.
  Comments are stripped and multiple statements are rejected before execution.
  ([`sql.worker.ts`](../src/workers/sql.worker.ts))
- Errors are mapped to presentable messages; raw stack traces never reach the UI.

---

## Operational notes

- Secrets live in Postgres, **encrypted** (see §1). The pre-M2 plaintext
  `.data/datasources.json` is migrated once via `pnpm import:datasources <orgId>`
  ([`scripts/migrate-datasources.ts`](../scripts/migrate-datasources.ts)); delete
  the file afterward. Keep `DATA_STUDIO_ENC_KEY` out of source control.
- Route handlers run on the **Node.js runtime** (`export const runtime = "nodejs"`)
  because `pg` needs `net`/`tls`.
- The build was verified to keep `pg` out of the client bundle (it's only reached
  through server route handlers).
