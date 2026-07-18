/**
 * Audit tests for the dashboard query scheduler.
 *
 * These drive the framework-agnostic `Scheduler` with COUNTER/SPY engines over
 * deterministic scenarios, proving the four orchestration properties:
 *   1. ensureLoaded is called once per source (idempotent residency).
 *   2. Rust `load_dataset` swaps are minimal (0 extra on single-source refresh;
 *      == distinct ids on interleaved multi-source, via builder batching).
 *   3. The result cache hits (duplicate widgets → one engine call; force-refresh
 *      → exactly one extra).
 *   4. Layout changes don't change a widget's cache key (so drag/resize can't
 *      re-query — the widget submits keyed on the cache key, never on layout).
 *
 * The swap counter models the worker's `ensureActive`: a swap happens only when
 * a builder query targets a different id than the currently-active one.
 */

import { describe, expect, it, vi } from "vitest";
import { Scheduler, type SchedulerConfig, type SourceResolver } from "./useQueryScheduler";
import type { AnalyticsEngine } from "./useAnalyticsEngine";
import type { Widget } from "@/lib/types/dashboard";
import { widgetCacheKey } from "@/lib/dashboard/hash";
import type { Query } from "@/lib/types/analytics";

// ── Test doubles ─────────────────────────────────────────────────────────────

/** A spy engine with counters; `runQueryOn` models the Rust activeId swap. */
function makeEngine() {
  let activeId: string | null = null;
  const counts = { ensureLoaded: 0, runQuery: 0, runSql: 0, swaps: 0 };
  const ensureLoadedById = new Map<string, number>();

  const engine = {
    ensureLoaded: vi.fn((id: string) => {
      counts.ensureLoaded++;
      ensureLoadedById.set(id, (ensureLoadedById.get(id) ?? 0) + 1);
      return Promise.resolve({
        rowCount: 3,
        columns: [{ name: "label", type: "string" as const }],
      });
    }),
    runQueryOn: vi.fn((id: string) => {
      counts.runQuery++;
      if (activeId !== id) {
        counts.swaps++; // models worker `ensureActive` → load_dataset
        activeId = id;
      }
      return Promise.resolve({
        payload: {
          points: [{ label: "a", value: 1 }],
          rows_matched: 1,
          rows_total: 1,
          metric_label: "COUNT(*)",
        },
        elapsedMs: 1,
      });
    }),
    runSqlOn: vi.fn(() => {
      counts.runSql++;
      return Promise.resolve({
        columns: [{ name: "x", type: "number" as const }],
        rows: [[1]],
        rowCount: 1,
        elapsedMs: 1,
      });
    }),
  };

  return {
    engine: engine as unknown as AnalyticsEngine,
    counts,
    ensureLoadedById,
  };
}

const resolver: SourceResolver = () => ({ kind: "rows", rows: [] });

function makeScheduler(engine: AnalyticsEngine, config?: SchedulerConfig) {
  return new Scheduler({ current: engine }, { current: resolver }, config);
}

/** Drain the microtask/macrotask queues so the async runner settles. */
async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

let widgetSeq = 0;
function builder(sourceId: string, query: Query): Widget {
  widgetSeq += 1;
  return {
    id: `w${widgetSeq}`,
    title: `w${widgetSeq}`,
    sourceId,
    queryKind: "builder",
    query,
    viz: { type: "bar" },
    layout: { x: 0, y: 0, w: 6, h: 6 },
  };
}
const countBy = (dim: string): Query => ({
  group_by: dim,
  aggregation: { func: "count" },
});

// ── 1. ensureLoaded fetches once, idempotent ────────────────────────────────

describe("Property 1 — ensureLoaded once per source (idempotent residency)", () => {
  it("loads a source exactly once across many widgets on it", async () => {
    const { engine, counts, ensureLoadedById } = makeEngine();
    const s = makeScheduler(engine);

    // Three widgets, same source, DIFFERENT queries (so none dedupe away).
    s.submit(builder("demo", countBy("region")));
    s.submit(builder("demo", countBy("category")));
    s.submit(builder("demo", countBy("channel")));
    await flush();

    expect(counts.ensureLoaded).toBe(1);
    expect(ensureLoadedById.get("demo")).toBe(1);
    // All three queries still executed against the resident dataset.
    expect(counts.runQuery).toBe(3);
  });

  it("does not reload a resident source on a later submit", async () => {
    const { engine, counts } = makeEngine();
    const s = makeScheduler(engine);

    s.submit(builder("demo", countBy("region")));
    await flush();
    expect(counts.ensureLoaded).toBe(1);

    s.submit(builder("demo", countBy("category")));
    await flush();
    expect(counts.ensureLoaded).toBe(1); // no refetch/re-register
  });
});

// ── 2. Rust swap count is minimal ───────────────────────────────────────────

describe("Property 2 — minimal load_dataset swaps", () => {
  it("single source / many widgets: 1 initial swap, 0 extra on refresh", async () => {
    const { engine, counts } = makeEngine();
    const s = makeScheduler(engine);

    const w1 = builder("demo", countBy("region"));
    const w2 = builder("demo", countBy("category"));
    const w3 = builder("demo", countBy("channel"));
    s.submit(w1);
    s.submit(w2);
    s.submit(w3);
    await flush();
    expect(counts.swaps).toBe(1); // only the initial load into Rust

    // Force-refresh every widget → re-run, but activeId already correct.
    s.submit(w1, true);
    s.submit(w2, true);
    s.submit(w3, true);
    await flush();
    expect(counts.swaps).toBe(1); // ZERO extra swaps
  });

  it("interleaved 2 sources: swaps == distinct ids, not widget count", async () => {
    const { engine, counts } = makeEngine();
    const s = makeScheduler(engine);

    // Submitted A,B,A,B — batching must group them so swaps == 2 (not 4).
    s.submit(builder("A", countBy("region")));
    s.submit(builder("B", countBy("region")));
    s.submit(builder("A", countBy("category")));
    s.submit(builder("B", countBy("category")));
    await flush();

    expect(counts.runQuery).toBe(4); // all four ran
    expect(counts.swaps).toBe(2); // one per distinct id
  });
});

// ── 3. Result cache actually hits ────────────────────────────────────────────

describe("Property 3 — result cache hits + force bypass", () => {
  it("duplicate widgets (same source+query) execute the engine once", async () => {
    const { engine, counts } = makeEngine();
    const s = makeScheduler(engine);

    const q = countBy("region");
    s.submit(builder("demo", q));
    s.submit(builder("demo", q)); // identical cache key → dedupe/cache
    await flush();

    expect(counts.runQuery).toBe(1);
  });

  it("force-refresh bypasses the cache for exactly one extra call", async () => {
    const { engine, counts } = makeEngine();
    const s = makeScheduler(engine);

    const w = builder("demo", countBy("region"));
    s.submit(w);
    await flush();
    expect(counts.runQuery).toBe(1);

    s.submit(w, true); // force → one extra call
    await flush();
    expect(counts.runQuery).toBe(2);

    s.submit(w); // cached again → no new call
    await flush();
    expect(counts.runQuery).toBe(2);
  });

  it("SQL widgets cache the same way (runSql once for duplicates)", async () => {
    const { engine, counts } = makeEngine();
    const s = makeScheduler(engine);

    const sqlWidget = (id: string): Widget => ({
      id,
      title: id,
      sourceId: "demo",
      queryKind: "sql",
      sql: "SELECT region, COUNT(*) FROM dataset GROUP BY region",
      viz: { type: "table" },
      layout: { x: 0, y: 0, w: 6, h: 6 },
    });
    s.submit(sqlWidget("s1"));
    s.submit(sqlWidget("s2"));
    await flush();

    expect(counts.runSql).toBe(1);
  });
});

// ── 3b. Cache is bounded: LRU eviction + TTL expiry ─────────────────────────

describe("Property 3b — bounded cache (LRU + TTL)", () => {
  it("evicts the least-recently-used entry beyond the size cap", async () => {
    const { engine, counts } = makeEngine();
    const s = makeScheduler(engine, { cacheMax: 2 });

    const wA = builder("demo", countBy("region"));
    const wB = builder("demo", countBy("category"));
    const wC = builder("demo", countBy("channel"));

    s.submit(wA);
    s.submit(wB);
    s.submit(wC); // cache now holds {B, C}; A (oldest) is evicted
    await flush();
    expect(counts.runQuery).toBe(3);

    // A was evicted → re-running it hits the engine again.
    s.submit(wA);
    await flush();
    expect(counts.runQuery).toBe(4);

    // C is still resident (most-recent) → served from cache, no new call.
    s.submit(wC);
    await flush();
    expect(counts.runQuery).toBe(4);
  });

  it("re-runs an entry once its TTL has elapsed", async () => {
    const clock = { t: 0 };
    const { engine, counts } = makeEngine();
    const s = makeScheduler(engine, { cacheTtlMs: 1000, now: () => clock.t });

    const w = builder("demo", countBy("region"));
    s.submit(w);
    await flush();
    expect(counts.runQuery).toBe(1);

    clock.t = 500; // still fresh
    s.submit(w);
    await flush();
    expect(counts.runQuery).toBe(1);

    clock.t = 2000; // past the 1000ms TTL → stale → re-run
    s.submit(w);
    await flush();
    expect(counts.runQuery).toBe(2);
  });
});

// ── 4. Drag/resize does NOT re-query ─────────────────────────────────────────

describe("Property 4 — layout changes never re-query", () => {
  it("the cache key is invariant under layout (x/y/w/h) changes", () => {
    const w = builder("demo", countBy("region"));
    const before = widgetCacheKey(w);
    const moved: Widget = { ...w, layout: { x: 4, y: 9, w: 3, h: 4 } };
    const after = widgetCacheKey(moved);
    // The widget submits keyed on this value → identical key = no re-query.
    expect(after).toBe(before);
  });

  it("re-submitting the same query after a layout move serves from cache", async () => {
    const { engine, counts } = makeEngine();
    const s = makeScheduler(engine);

    const w = builder("demo", countBy("region"));
    s.submit(w);
    await flush();
    expect(counts.runQuery).toBe(1);

    // Simulate what a drag produces: a new widget object, same query, new box.
    const moved: Widget = { ...w, layout: { x: 5, y: 2, w: 4, h: 5 } };
    s.submit(moved);
    await flush();
    expect(counts.runQuery).toBe(1); // no extra engine call
  });
});
