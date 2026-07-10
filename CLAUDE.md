# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Data Studio is a browser-based BI platform (Metabase / Looker Studio style): a
Next.js 14 App Router app where heavy data compute runs client-side (Rust→WASM
builder engine + DuckDB-WASM SQL engine on Web Workers), with a multi-tenant
Postgres metadata backend behind `/api/*` route handlers. It has been built out
through a phased roadmap (M0–M10) covering an MBQL-like query IR, pushdown
execution, auth/orgs, multiple dashboards, chart-type parity, free-form canvas
mode, and public/embed sharing. See [docs/roadmap.md](docs/roadmap.md) for the
milestone map and [docs/architecture.md](docs/architecture.md) for the deep dive.

## Commands

```bash
pnpm exec next dev        # dev server WITHOUT the wasm-pack pre-hook (use this)
pnpm exec next build      # production build WITHOUT the wasm-pack pre-hook (use this)
pnpm typecheck            # tsc --noEmit
pnpm test                 # vitest run (once)
pnpm test:watch           # vitest watch
pnpm lint                 # next lint

pnpm db:generate          # emit SQL migration from schema.ts changes
pnpm db:migrate           # apply migrations to DATABASE_URL
pnpm db:push              # sync schema straight to DB (dev only)
```

Run a single test file / test:
```bash
pnpm exec vitest run src/lib/query/compile/compile.test.ts
pnpm exec vitest run -t "compiles a window function"
```

**Critical (see [memory](/.claude/projects/-Users-zaberhossen-Projects-data-studio/memory/build-without-wasm-pack.md)):**
`pnpm dev` / `pnpm build` run `predev`/`prebuild` hooks that invoke `wasm-pack`,
which fails when the Rust toolchain isn't installed. The compiled WASM is
committed under `src/wasm/pkg/`, so **always use `pnpm exec next dev` /
`pnpm exec next build`** for TS/React work — they skip the hook. Only run
`pnpm wasm:build` when you actually changed the Rust crate in `wasm/`.

The standard verification loop for any change is: `pnpm typecheck` → `pnpm test`
→ `pnpm exec next build`. There is **no browser in this environment** — chart /
canvas / sharing rendering can only be eyeballed via a manual `pnpm exec next dev`
pass (a Docker Postgres named `data-studio-pg` backs the app DB locally).

## Architecture — the load-bearing invariants

These four rules explain most design decisions. Breaking one is almost always a bug.

1. **React never holds raw rows.** Datasets (up to hundreds of thousands of rows)
   live only inside the Web Workers or a `useRef`. React state holds metadata,
   declarative queries, and one bounded result page — never the dataset.

2. **Credentials stay server-side, sealed.** Data-source secrets are AES-256-GCM
   encrypted at rest ([src/lib/server/crypto.ts](src/lib/server/crypto.ts), key
   from `DATA_STUDIO_ENC_KEY`). `DataSourceMeta` is the only thing that crosses to
   the client — it never carries a secret. The `/api/datasources/[id]/run`
   endpoint accepts the **IR, never client SQL**.

3. **Multi-tenancy by construction.** Every tenant table carries `orgId`. Every
   store method takes an `AuthContext {userId, orgId, role}` and ANDs
   `requireOrg(table.orgId, ctx)` into its `WHERE`; mutations call
   `assertCanWrite(ctx)`. Grep `requireOrg` to audit the invariant. See
   [src/lib/db/scope.ts](src/lib/db/scope.ts). Route handlers get the context via
   `resolveAuth()` ([src/lib/auth/api.ts](src/lib/auth/api.ts)).

4. **Layout edits never trigger re-queries.** Grid and canvas both mutate the DOM
   directly during a drag/resize gesture and commit layout on gesture-end; results
   are never refetched on a layout change.

### The two boundaries

- **Main-thread ↔ worker.** Two workers behind one hook
  ([useAnalyticsEngine.ts](src/hooks/useAnalyticsEngine.ts), Promise API matched
  by `requestId`): [chart.worker.ts](src/workers/chart.worker.ts) (Rust→WASM
  visual builder) and [sql.worker.ts](src/workers/sql.worker.ts) (DuckDB-WASM raw
  SQL). A dataset crosses in **once**; thereafter only small queries and bounded
  pages cross back.
- **Browser ↔ server.** Client-side sources (file upload: CSV/Parquet/JSON) are
  read in the browser and never touch the server. Server-side sources (Postgres,
  MySQL, http-file, rest-api) are reached only through `/api/datasources/*`.

### Compute: Query IR → SQL

The builder edits an MBQL-like **`QueryIR`** ([src/lib/query/ir.ts](src/lib/query/ir.ts)):
multi-dimension (with temporal bucketing), multi-aggregation, joins, calculated
fields (a closed `Expr` algebra — no free SQL text), window functions, rich filter
trees, having, order, limit. Sort/having reference aggregations by **ordinal**,
not alias strings.

- `compileIR(ir, dialect, options)` ([src/lib/query/compile/](src/lib/query/compile/))
  → `{sql, params, columns}`. Dialects: `duckdb`, `postgres`, `mysql`.
- **`chooseExecution(kind, ir)`** ([compile/route.ts](src/lib/query/compile/route.ts))
  routes **LOCAL** (DuckDB over the resident dataset) vs **PUSHDOWN** (connector
  runs it on the live DB). Live DBs push down when the IR aggregates or joins;
  file/fetch sources always run LOCAL. User-overridable via the execution toggle.
- The UI holds an **`IrDraft`** ([src/lib/query/ir-draft.ts](src/lib/query/ir-draft.ts));
  `compileIrDraft` builds the IR and `irToDraft` is its inverse (for opening saved
  queries / editing widgets).

**Three injection rules (enforced in [compile/compile.ts](src/lib/query/compile/compile.ts)):**
identifiers come only from the introspected allowlist then are dialect-quoted (an
out-of-allowlist column/table throws `CompileError`); filter values are always
bound params; expressions are a closed algebra (no user SQL emitted). Joins
additionally validate physical tables against `CompileOptions.allowedTables` and
columns against the connector's `columnAllowlist()`.

### Backend / persistence

Drizzle ORM over `pg`. Schema in [src/lib/db/schema.ts](src/lib/db/schema.ts),
migrations in [src/lib/db/migrations/](src/lib/db/migrations/) (generate with
`db:generate`, apply with `db:migrate`). **Note:** drizzle-kit does not read
`.env.local` — [drizzle.config.ts](drizzle.config.ts) has a small loader for it.

Store seams are swapped at their factory singletons (e.g. `getStore()` in
[datasource-store.ts](src/lib/server/datasource-store.ts)) — **components never
change when the backend does.** Auth is Auth.js (NextAuth v5) with DB sessions;
route groups are `(app)` (authed shell), `(public)` (share/embed), plus `api`.

Connectors ([src/lib/server/connectors/](src/lib/server/connectors/)) all
implement the `Connector` interface; `index.ts`'s `switch` is the single place a
new kind slots in. Instances are pool-owning singletons cached on `globalThis`.

### Sharing

Public sharing uses **frozen snapshots**: `buildSnapshot` freezes results into
`share_links.snapshot` (jsonb); `/public/[token]` and `/embed/[token]` run **no
engine** and expose no `sourceId`/`table`/`sql`/`ir`. `getPublicByToken` is the
only unauthenticated data path (opaque token = capability), rate-limited, honoring
revoke/expire. Frame headers in [next.config.mjs](next.config.mjs): embed routes
allow `frame-ancestors`, everything else is `X-Frame-Options: DENY`. Audit logging
([src/lib/server/audit.ts](src/lib/server/audit.ts)) is fire-and-forget and must
never break a request.

### Dashboards & canvas

A dashboard supports two lossless-togglable layout modes: responsive **grid**
(react-grid-layout) and free-form **canvas** (react-moveable + react-selecto,
drag/resize/rotate/multi-select). Widgets have a `kind` (`query` | `text` | `image`
| `shape` | `line`); non-query elements are skipped by the query scheduler.
[DashboardView.tsx](src/components/dashboard/DashboardView.tsx) is the shared
read-only render used by both the authed panel and public/embed pages.

## Conventions

- Path alias `@/*` → `src/*`. Charts are Recharts; icons are lucide-react; UI
  primitives are shadcn/ui in [src/components/ui/](src/components/ui/); styling is
  Tailwind with HSL design tokens (including `--viz-*` chart tokens) in `globals.css`.
- `useSyncExternalStore` snapshots (schedulers, stores) **must return a stable
  reference** from `getSnapshot` — returning a fresh object each call causes
  "Maximum update depth exceeded". Precompute and memoize.
- When adding an IR feature, the full path is usually: `ir.ts` (type) →
  `compile.ts` (+ dialects) → `ir-draft.ts` (draft + `compileIrDraft`/`irToDraft`)
  → builder UI → a golden compile test. Server-only modules live under
  `src/lib/server/` and must never be imported into client components.
