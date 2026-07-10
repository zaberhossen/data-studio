# Data Studio — Documentation

Data Studio is a browser-based **Business Intelligence platform**. It connects to
real data sources (files, Postgres), runs heavy analytical work off the main
thread in **two WebAssembly engines**, and renders the results as charts and a
paginated table — all while keeping the React UI at a locked 60 FPS.

The defining constraint of the whole system: **React never holds raw rows.**
Datasets live in the workers (Rust/WASM + DuckDB-WASM); React only ever holds
small metadata, declarative queries, and bounded result pages.

---

## Documentation map

| Doc | What's inside |
|---|---|
| [architecture.md](architecture.md) | The system's shape: the browser/server boundary, the dual-engine workers, the private worker↔worker channel, the shared contracts, and the engine hook. |
| [features.md](features.md) | Every feature currently in the product, grouped by area. |
| [data-sources.md](data-sources.md) | The data-source layer: connectors, API routes, server-side store, the panel UI, and how a source is loaded into both engines. |
| [results-table.md](results-table.md) | The results table: the `ResultTable` view-model + adapters, the presentational grid, re-query pagination/sort, CSV export, and the Chart\|Table tabs. |
| [workflows.md](workflows.md) | End-to-end walkthroughs: add a source, run a builder query, run SQL, paginate, sort, export. |
| [security.md](security.md) | The non-negotiable security model: credential handling, parameterized queries, allowlisting, caps, and the read-only SQL guard. |
| [development.md](development.md) | Project structure, scripts, build/test workflow, and coding conventions. |
| [gap-analysis.md](gap-analysis.md) | Feature-by-feature comparison of the current product vs Metabase / Google Data Studio across the four focus areas. |
| [roadmap.md](roadmap.md) | The phased milestone plan (M0–M10) to reach Metabase / Data Studio parity. |

---

## One-paragraph architecture

The app is a Next.js 14 (App Router) frontend plus a thin API-route backend.
**Client-side sources** (file uploads) are read in the browser and handed to the
workers directly. **Server-side sources** (Postgres) are reached only through
`/api/datasources/*` route handlers — the only place credentials live and the
only component that can open a TCP connection to a database. A custom hook,
[`useAnalyticsEngine`](../src/hooks/useAnalyticsEngine.ts), owns **two Web
Workers**: a Rust→WASM engine for the visual query builder and DuckDB-WASM for
raw SQL. A dataset crosses into the workers **once**; every query after that
sends only a tiny request and returns a tiny result.

```
                          ┌──────────────────────────── Browser ────────────────────────────┐
                          │                                                                  │
   File (CSV/Parquet/JSON)│   ┌─────────────┐        ┌───────────────────────────────────┐  │
   ───────────────────────┼──►│  React UI   │        │            Web Workers            │  │
                          │   │ (metadata,  │◄──────►│  ┌─────────────┐  ┌─────────────┐ │  │
                          │   │  queries,   │  hook  │  │ chart.worker│  │ sql.worker  │ │  │
                          │   │  result     │        │  │ Rust / WASM │◄─┤ DuckDB-WASM │ │  │
                          │   │  pages)     │        │  └─────────────┘  └─────────────┘ │  │
                          │   └──────┬──────┘        └───────────────────────▲───────────┘  │
                          │          │ fetch (metadata only)                  │ fetch(rows)  │
                          └──────────┼─────────────────────────────────────  ┼──────────────┘
                                     ▼                                        ▼
                          ┌───────────────────────── Next.js API routes ─────────────────────┐
                          │  /api/datasources[...]  → Connector (pg Pool) → PostgreSQL        │
                          │  credentials live here, server-side only                          │
                          └───────────────────────────────────────────────────────────────────┘
```

## Status at a glance

- **Engines:** Rust/WASM builder engine + DuckDB-WASM SQL engine — both shipping.
- **Sources:** built-in demo, file upload (CSV/Parquet/JSON), PostgreSQL. MySQL /
  HTTP-file / REST-API are creatable in the UI but their connectors are deferred.
- **Query surfaces:** visual query builder, raw SQL editor, and a two-way
  Builder⇄SQL bridge.
- **Results:** Chart (Recharts) and a paginated, sortable, exportable table.
- **Tests:** adapter unit tests via Vitest (`pnpm test`).
