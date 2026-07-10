# Development

## Prerequisites

- **Node** + **pnpm** (`packageManager` pins the pnpm version).
- **Rust + WASM toolchain** (only needed to rebuild the engine):
  ```bash
  rustup target add wasm32-unknown-unknown
  cargo install wasm-pack
  ```

The compiled WASM package is committed under `src/wasm/pkg/`, so you can run,
typecheck, test, and build the frontend **without** the Rust toolchain — as long
as you bypass the `wasm-pack` pre-hooks (see below).

---

## Scripts

| Command | Action |
|---|---|
| `pnpm dev` | `predev` builds WASM (dev) then starts Next.js |
| `pnpm build` | `prebuild` builds WASM (release) then `next build` |
| `pnpm exec next dev` | Start Next.js **without** the WASM pre-hook (uses committed `pkg/`) |
| `pnpm exec next build` | Production build **without** the WASM pre-hook |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Run Vitest once |
| `pnpm test:watch` | Vitest watch mode |
| `pnpm wasm:build` / `wasm:dev` | Rebuild the Rust engine only |
| `cd wasm && cargo test` | Native unit tests for the engine (no WASM) |
| `pnpm db:generate` | Emit SQL migrations from `src/lib/db/schema.ts` changes |
| `pnpm db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `pnpm db:push` | Sync schema straight to the DB (dev only) |
| `pnpm db:studio` | Open Drizzle Studio |

> **Gotcha:** `pnpm dev` / `pnpm build` fail if `wasm-pack` isn't installed
> (the `pre*` hooks). When you're only touching TS/React, use
> `pnpm exec next dev` / `pnpm exec next build`, which skip the hook and use the
> already-committed `src/wasm/pkg/`.

---

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Application Postgres DB (our metadata store; see below) |
| `AUTH_SECRET` | — | Signs the Auth.js session JWT (`npx auth secret` / `openssl rand -base64 32`) |
| `DATA_STUDIO_ENC_KEY` | — | Base64 32-byte key sealing data-source secrets (AES-256-GCM) |
| `DATA_STUDIO_ENC_KEYS` | — | Optional versioned keyring for rotation (`1:<b64>,2:<b64>`) |
| `DATA_STUDIO_STORE` | `.data/datasources.json` | Legacy file source store (replaced by the DB in M2) |
| `DATA_STUDIO_ROW_CAP` | `100000` | Hard row cap for server pulls |
| `DATA_STUDIO_QUERY_TIMEOUT_MS` | `30000` | Per-request query timeout |

Copy `.env.example` to `.env.local` and fill in values. `.data/` and `.env*.local`
are gitignored (they can contain credentials).

---

## Database (application metadata store)

Introduced in milestone **M0** (see [roadmap.md](roadmap.md)). This is Data
Studio's **own** Postgres database — users, orgs, dashboards, encrypted
data-source secrets, share links — and is distinct from the *customer* databases
the connectors reach.

- **ORM:** Drizzle (`drizzle-orm` on the existing `pg` pool). Schema is plain TS
  in [`src/lib/db/schema.ts`](../src/lib/db/schema.ts); the client singleton is
  [`src/lib/db/client.ts`](../src/lib/db/client.ts); tenant scoping helpers are in
  [`src/lib/db/scope.ts`](../src/lib/db/scope.ts).
- **Secrets:** sealed at rest by [`src/lib/server/crypto.ts`](../src/lib/server/crypto.ts)
  (AES-256-GCM, versioned keys) — plaintext credentials never hit the DB.
- **Setup:**
  ```bash
  createdb data_studio
  cp .env.example .env.local     # set DATABASE_URL + DATA_STUDIO_ENC_KEY
  pnpm db:migrate                # apply src/lib/db/migrations/*
  ```
- **Note:** `esbuild` is allow-listed in `pnpm-workspace.yaml` (`onlyBuiltDependencies`)
  because `drizzle-kit` needs it; everything else stays unbuilt.

---

## Authentication & tenancy (M1)

Auth.js (NextAuth v5) with a **Credentials** provider and **JWT sessions**
(the strategy Credentials requires; OAuth + database sessions can layer on later).

- **Config split:** [`src/auth.config.ts`](../src/auth.config.ts) is edge-safe (no
  DB) and used by [`src/middleware.ts`](../src/middleware.ts) to gate routes;
  [`src/auth.ts`](../src/auth.ts) adds the Credentials provider + DB-backed
  jwt/session callbacks (Node runtime).
- **Route groups:** the authed workspace lives under `src/app/(app)/` (its
  layout resolves the session and seeds `SessionProvider`); `/login` + `/signup`
  are public. `/public` + `/embed` are reserved for share pages (M9).
- **Session shape:** `session.user` carries `{ id, orgId, role }`. Server code
  calls [`requireAuthContext()`](../src/lib/auth/context.ts) to get
  `{ userId, orgId, role }` (throws 401 without a session/active org).
- **Sign-up** ([`actions.ts`](../src/lib/auth/actions.ts)) provisions user + org +
  `owner` membership in one transaction — a user always has an org.
- **Passwords** are hashed with Node's scrypt
  ([`password.ts`](../src/lib/auth/password.ts)) — no native dependency.
- **Tenancy:** every tenant table has `org_id`; store methods take the
  `AuthContext` and AND `requireOrg(...)` into every query
  ([`scope.ts`](../src/lib/db/scope.ts)).

---

## Tech stack

| Layer | Tech |
|---|---|
| Framework | Next.js 14 (App Router) + TypeScript |
| UI | shadcn/ui (Radix primitives) + Tailwind (HSL design tokens) |
| Charts | Recharts |
| Table | `@tanstack/react-table` (headless) + shadcn Table |
| Builder engine | Rust → WebAssembly (`wasm-bindgen`, `serde-wasm-bindgen`) |
| SQL engine | DuckDB-WASM + Apache Arrow |
| DB driver | `pg` (server-side, pooled) |
| Threading | native Web Workers (`{ type: "module" }`) + a private `MessageChannel` |
| Tests | Vitest |
| Package manager | pnpm |

---

## Conventions

- **Never put raw rows in React state.** Datasets live in workers / refs. If you
  need data in React, it must be metadata, a small query, or one bounded page.
- **Depend on destructured engine methods** in effects, never the whole `engine`
  object (its identity changes when `loading`/`error` change → infinite loops).
- **Server-only code stays under `src/lib/server/`** and is never imported by a
  client component or worker. Route handlers set `runtime = "nodejs"`.
- **Design-token-only styling** — use shadcn/Tailwind tokens so light/dark works
  for free. No hard-coded colors.
- **Types are the contracts.** Cross-boundary payloads are typed in
  `src/lib/types/`; keep both sides in lock-step.
- **Presentational vs. smart split** — leaf components take data + callbacks;
  smart hooks/containers (`useDataSources`, `ResultsRegion`) own state and talk to
  the engine.

---

## Where things live

See [architecture.md](architecture.md#component--module-layers) for the full
module map. Quick index:

- Engines/workers → `src/workers/`, hook → `src/hooks/useAnalyticsEngine.ts`
- Data sources → `src/components/sources/`, `src/hooks/useDataSources.ts`,
  `src/lib/server/`, `src/app/api/datasources/`
- Results → `src/components/results/`, `src/lib/results/`, `src/lib/types/results.ts`
- Query surfaces → `src/components/query/`, `src/lib/query/schema.ts`
- Shared contracts → `src/lib/types/`
