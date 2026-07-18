"use client";

/**
 * useQueryScheduler — the dashboard's query brain.
 *
 * The workers are single-threaded, so loading a dashboard must NOT fire every
 * widget's query at once. This scheduler sits between the widgets and the keyed
 * engine and enforces four things:
 *
 *   1. QUEUE — widget queries run one at a time, in order; each result streams
 *      back to its widget the moment it finishes (each widget owns its loading
 *      state), instead of the page freezing until all are done.
 *   2. CACHE — results are cached by (sourceId + stable-hash(query|sql)). A
 *      duplicate widget, a re-render, or a reloaded dashboard reuses the cached
 *      result instead of re-executing on the worker.
 *   3. DEDUPE — resubmitting the same widget replaces its queued task; two
 *      widgets with an identical cache key share the one cached result.
 *   4. BUILDER BATCHING — because the Rust engine holds ONE active dataset,
 *      queued builder tasks are drained grouped by sourceId, so a dashboard
 *      refresh triggers at most one `load_dataset` swap per source.
 *
 * Force-refresh bypasses the cache for a single widget (then repopulates it).
 * Results route to the right widget by widget id via a subscription model
 * (`useWidgetResult`), so only the widget whose result changed re-renders.
 *
 * INVARIANT: the scheduler holds only normalized `ResultTable` pages +
 * `ChartPayload`s — never raw rows. The datasets live in the workers.
 */

import * as React from "react";
import type {
  AnalyticsEngine,
  SourceSpec,
} from "@/hooks/useAnalyticsEngine";
import type { ChartPayload } from "@/lib/types/analytics";
import type { SqlError } from "@/lib/types/sql";
import type { Widget } from "@/lib/types/dashboard";
import { compileIR, DuckDbDialect } from "@/lib/query/compile";
import { irColumns } from "@/lib/query/ir";
import { widgetCacheKey } from "@/lib/dashboard/hash";
import {
  chartPayloadToResultTable,
  sqlResultToResultTable,
  type ResultTable,
} from "@/lib/types/results";

/** How many rows a SQL/table widget pulls per query (the visible page). */
const WIDGET_SQL_PAGE = 200;

/** Result-cache bounds: at most N entries (LRU), each valid for T ms. */
const DEFAULT_CACHE_MAX = 100;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/** Scheduler tunables (all optional; `now` is injectable for deterministic tests). */
export interface SchedulerConfig {
  /** Max cached results before the least-recently-used is evicted. */
  cacheMax?: number;
  /** How long a cached result stays fresh, in ms. */
  cacheTtlMs?: number;
  /** Clock source (defaults to Date.now). */
  now?: () => number;
}

export type WidgetResultStatus =
  | "idle"
  | "loading"
  | "data"
  | "empty"
  | "error";

/** The normalized, row-free result a widget renders. */
export interface WidgetResult {
  status: WidgetResultStatus;
  /** Normalized page for the table viz (both engines feed this shape). */
  table: ResultTable | null;
  /** Chart-native payload for bar/line/kpi (builder path only). */
  payload: ChartPayload | null;
  error: string | null;
  elapsedMs?: number;
}

const IDLE: WidgetResult = {
  status: "idle",
  table: null,
  payload: null,
  error: null,
};

/** Resolve a widget's `sourceId` to how the engine should load it. */
export type SourceResolver = (sourceId: string) => SourceSpec | null;

interface Task {
  widget: Widget;
  cacheKey: string;
  force: boolean;
}

interface Cached {
  table: ResultTable;
  payload: ChartPayload | null;
  elapsedMs?: number;
  empty: boolean;
  /** When this entry was stored (ms) — drives TTL expiry. */
  at: number;
}

type Residency =
  | { state: "loading"; promise: Promise<void> }
  | { state: "ready" }
  | { state: "error"; message: string };

function toMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const e = err as SqlError;
    const where = e.line != null ? ` (line ${e.line})` : "";
    return `${e.message}${where}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The scheduler controller — a plain object kept in a ref so it's stable across
 * renders. It reads the live engine + resolver from refs the hook keeps fresh,
 * so it never goes stale without being recreated.
 *
 * Exported for unit tests (it's framework-agnostic; the refs are the only React
 * touch-point and a plain `{ current }` satisfies them).
 */
export class Scheduler {
  private results = new Map<string, WidgetResult>();
  private listeners = new Map<string, Set<() => void>>();
  private cache = new Map<string, Cached>();
  private residency = new Map<string, Residency>();
  private queue: Task[] = [];
  private draining = false;
  /** Builder source drained most recently — keep pulling its tasks first. */
  private lastBuilderSource: string | null = null;

  private cacheMax: number;
  private cacheTtlMs: number;
  private now: () => number;

  constructor(
    private engineRef: React.MutableRefObject<AnalyticsEngine>,
    private resolverRef: React.MutableRefObject<SourceResolver>,
    config: SchedulerConfig = {},
  ) {
    this.cacheMax = config.cacheMax ?? DEFAULT_CACHE_MAX;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = config.now ?? Date.now;
  }

  // ── Result cache (bounded: LRU eviction + TTL freshness) ──────────────────
  /** Read a still-fresh entry, refreshing its LRU recency; expired → dropped. */
  private cacheGet(key: string): Cached | undefined {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.cacheTtlMs) {
      this.cache.delete(key);
      return undefined;
    }
    // Move to the most-recent end (Map preserves insertion order).
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit;
  }

  /** Store an entry (stamped now), evicting the oldest beyond the size cap. */
  private cachePut(key: string, cached: Omit<Cached, "at">) {
    this.cache.delete(key);
    this.cache.set(key, { ...cached, at: this.now() });
    while (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  // ── Subscription (per-widget, for useSyncExternalStore) ───────────────────
  subscribe = (widgetId: string, cb: () => void): (() => void) => {
    let set = this.listeners.get(widgetId);
    if (!set) {
      set = new Set();
      this.listeners.set(widgetId, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  };

  getSnapshot = (widgetId: string): WidgetResult =>
    this.results.get(widgetId) ?? IDLE;

  private set(widgetId: string, result: WidgetResult) {
    this.results.set(widgetId, result);
    this.listeners.get(widgetId)?.forEach((cb) => cb());
  }

  // ── Submission ────────────────────────────────────────────────────────────
  /** Enqueue a widget's query. `force` bypasses the cache for this run. */
  submit(widget: Widget, force = false) {
    const cacheKey = widgetCacheKey(widget);

    // Fast path: a cached result and no force → serve instantly, no queue.
    if (!force) {
      const hit = this.cacheGet(cacheKey);
      if (hit) {
        this.set(widget.id, {
          status: hit.empty ? "empty" : "data",
          table: hit.table,
          payload: hit.payload,
          error: null,
          elapsedMs: hit.elapsedMs,
        });
        return;
      }
    }

    // Nothing to run for an unconfigured widget.
    if (widget.queryKind === "builder" && !widget.query) {
      this.set(widget.id, { ...IDLE, status: "empty" });
      return;
    }
    if (widget.queryKind === "sql" && !widget.sql?.trim()) {
      this.set(widget.id, { ...IDLE, status: "empty" });
      return;
    }
    if (widget.queryKind === "ir" && !widget.ir) {
      this.set(widget.id, { ...IDLE, status: "empty" });
      return;
    }

    // Replace any queued task for this widget (dedupe), then mark it loading.
    this.queue = this.queue.filter((t) => t.widget.id !== widget.id);
    this.queue.push({ widget, cacheKey, force });
    this.set(widget.id, {
      ...(this.results.get(widget.id) ?? IDLE),
      status: "loading",
      error: null,
    });
    void this.drain();
  }

  /** Drop every cached/queued/subscribed trace of a widget (it was removed). */
  forget(widgetId: string) {
    this.queue = this.queue.filter((t) => t.widget.id !== widgetId);
    this.results.delete(widgetId);
    this.listeners.delete(widgetId);
  }

  // ── Residency (idempotent per-source load) ────────────────────────────────
  private ensureResident(sourceId: string): Promise<void> {
    const current = this.residency.get(sourceId);
    if (current?.state === "ready") return Promise.resolve();
    if (current?.state === "loading") return current.promise;

    const spec = this.resolverRef.current(sourceId);
    if (!spec) {
      const message = `Source "${sourceId}" is unavailable.`;
      this.residency.set(sourceId, { state: "error", message });
      return Promise.reject(new Error(message));
    }
    const promise = this.engineRef.current
      .ensureLoaded(sourceId, spec)
      .then(() => {
        this.residency.set(sourceId, { state: "ready" });
      })
      .catch((err) => {
        this.residency.set(sourceId, { state: "error", message: toMessage(err) });
        throw err;
      });
    this.residency.set(sourceId, { state: "loading", promise });
    return promise;
  }

  // ── The single serial runner ──────────────────────────────────────────────
  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const task = this.pickNext();
        await this.run(task);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Pick the next task, preferring another builder task for the source we just
   * ran — that keeps the Rust engine's active dataset stable across a run of
   * queries and avoids repeated `load_dataset` swaps.
   */
  private pickNext(): Task {
    if (this.lastBuilderSource) {
      const idx = this.queue.findIndex(
        (t) =>
          t.widget.queryKind === "builder" &&
          t.widget.sourceId === this.lastBuilderSource,
      );
      if (idx !== -1) return this.queue.splice(idx, 1)[0];
    }
    return this.queue.shift()!;
  }

  private async run(task: Task) {
    const { widget, cacheKey, force } = task;
    try {
      await this.ensureResident(widget.sourceId);

      // A cache entry may have appeared (a duplicate widget ran first).
      if (!force) {
        const hit = this.cacheGet(cacheKey);
        if (hit) {
          this.set(widget.id, {
            status: hit.empty ? "empty" : "data",
            table: hit.table,
            payload: hit.payload,
            error: null,
            elapsedMs: hit.elapsedMs,
          });
          return;
        }
      }

      let cached: Omit<Cached, "at">;
      if (widget.queryKind === "builder") {
        this.lastBuilderSource = widget.sourceId;
        const { payload, elapsedMs } = await this.engineRef.current.runQueryOn(
          widget.sourceId,
          widget.query!,
        );
        cached = {
          table: chartPayloadToResultTable(payload, elapsedMs),
          payload,
          elapsedMs,
          empty: payload.points.length === 0,
        };
      } else {
        // SQL runs verbatim; IR compiles to inlined LOCAL SQL over the resident
        // table (its own referenced columns form the compiler allowlist). Both
        // ride the same DuckDB `runSqlOn` path.
        const statement =
          widget.queryKind === "ir"
            ? compileIR(
                {
                  ...widget.ir!,
                  source: { table: this.engineRef.current.tableNameForId(widget.sourceId) },
                },
                DuckDbDialect,
                irColumns(widget.ir!),
                { inline: true },
              ).sql
            : widget.sql!;
        const result = await this.engineRef.current.runSqlOn(
          widget.sourceId,
          statement,
          { limit: WIDGET_SQL_PAGE, offset: 0 },
        );
        cached = {
          table: sqlResultToResultTable(result, 0, WIDGET_SQL_PAGE),
          payload: null,
          elapsedMs: result.elapsedMs,
          empty: result.rowCount === 0,
        };
      }

      this.cachePut(cacheKey, cached);
      this.set(widget.id, {
        status: cached.empty ? "empty" : "data",
        table: cached.table,
        payload: cached.payload,
        error: null,
        elapsedMs: cached.elapsedMs,
      });
    } catch (err) {
      this.set(widget.id, {
        status: "error",
        table: null,
        payload: null,
        error: toMessage(err),
      });
    }
  }

  /** Invalidate a source's residency + drop its cached results (data changed). */
  invalidateSource(sourceId: string) {
    this.residency.delete(sourceId);
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${sourceId}::`)) this.cache.delete(key);
    }
  }
}

export interface QueryScheduler {
  submit: (widget: Widget, force?: boolean) => void;
  forget: (widgetId: string) => void;
  invalidateSource: (sourceId: string) => void;
  subscribe: (widgetId: string, cb: () => void) => () => void;
  getSnapshot: (widgetId: string) => WidgetResult;
}

/**
 * Create the dashboard scheduler. `resolveSource` maps a widget's sourceId to a
 * `SourceSpec` (how to load it) — supplied by the dashboard from its source
 * list. The returned object is stable across renders.
 */
export function useQueryScheduler(
  engine: AnalyticsEngine,
  resolveSource: SourceResolver,
  config?: SchedulerConfig,
): QueryScheduler {
  // Keep live refs so the stable controller always reads current deps.
  const engineRef = React.useRef(engine);
  // eslint-disable-next-line react-hooks/refs -- latest-value ref: the stable Scheduler reads engine at submit time, never during render
  engineRef.current = engine;
  const resolverRef = React.useRef(resolveSource);
  // eslint-disable-next-line react-hooks/refs -- latest-value ref: the stable Scheduler reads resolveSource at submit time, never during render
  resolverRef.current = resolveSource;

  // Lazily create the Scheduler once; useState's initializer keeps it stable.
  const [s] = React.useState(() => new Scheduler(engineRef, resolverRef, config));

  return React.useMemo<QueryScheduler>(
    () => ({
      submit: (widget, force) => s.submit(widget, force),
      forget: (widgetId) => s.forget(widgetId),
      invalidateSource: (sourceId) => s.invalidateSource(sourceId),
      subscribe: s.subscribe,
      getSnapshot: s.getSnapshot,
    }),
    [s],
  );
}

/** Subscribe a widget to its live result. Only re-renders on its own changes. */
export function useWidgetResult(
  scheduler: QueryScheduler,
  widgetId: string,
): WidgetResult {
  return React.useSyncExternalStore(
    React.useCallback(
      (cb) => scheduler.subscribe(widgetId, cb),
      [scheduler, widgetId],
    ),
    () => scheduler.getSnapshot(widgetId),
    () => IDLE,
  );
}
