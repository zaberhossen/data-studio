"use client";

/**
 * useDataSources — the client orchestration layer between the data-source panel
 * and the engine hook. It owns ONLY metadata (the source list, per-source live
 * status, and the active source's field schema). It NEVER holds raw rows: every
 * `activate` hands rows straight into the engine workers and keeps only the
 * resulting `{ rowCount, columns }` summary.
 *
 * Three source classes are unified behind one list + `activate`:
 *   • Demo      — the built-in 200k mock dataset (client-generated → engine.load)
 *   • File      — a client-side upload (bytes → engine.loadFile)
 *   • Server    — Postgres/etc. behind /api/datasources (engine.loadFromSource)
 */

import * as React from "react";
import type { AnalyticsEngine, SourceSpec } from "@/hooks/useAnalyticsEngine";
import type {
  ConnectionTestResult,
  CreateDataSourceInput,
  DataSourceMeta,
  DataSourceStatus,
  SourceSchema,
} from "@/lib/types/datasource";
import type { SqlColumn } from "@/lib/types/sql";
import { applyFieldOverrides, fieldsFromColumns, type Field, type FieldOverride } from "@/lib/query/schema";
import { SALES_FIELDS } from "@/lib/data/sales-schema";
import { generateSalesData } from "@/lib/data/mock-source";
import { getFieldOverridesStore } from "@/lib/fields/overrides-store";

/** UI field → engine column (for the demo's known schema on the `rows` spec). */
function fieldToColumn(f: Field): SqlColumn {
  return {
    name: f.name,
    type:
      f.dataType === "number"
        ? "number"
        : f.dataType === "boolean"
          ? "bool"
          : f.dataType === "date"
            ? "date"
            : "string",
  };
}

/** The built-in demo source id (no server record, not removable). */
export const DEMO_SOURCE_ID = "demo";

const DEMO_SOURCE: SourceView = {
  id: DEMO_SOURCE_ID,
  name: "Demo · Sales (200k)",
  kind: "file",
  status: "idle",
  tableName: "dataset",
  builtin: true,
};

/** A source as the panel renders it — meta plus client-origin flags. */
export interface SourceView extends DataSourceMeta {
  /** Built-in demo (generated client-side; cannot be removed). */
  builtin?: boolean;
  /** Client-only file upload (no server record). */
  local?: boolean;
}

interface LiveState {
  status: DataSourceStatus;
  rowCount?: number;
  error?: string;
}

export interface DataSourcesApi {
  sources: SourceView[];
  activeId: string | null;
  activeSource: SourceView | null;
  /** Field schema of the active source (post-overrides) — feeds the existing field browser. */
  activeFields: Field[];
  /** Overrides for the active source, keyed by column name (for the Fields panel). */
  fieldOverrides: Record<string, FieldOverride>;
  /** Override a field's role/label for a source; flows into `activeFields`/`getFields`. */
  setFieldOverride: (sourceId: string, column: string, patch: FieldOverride) => Promise<void>;
  /** Clear a single field's override, reverting it to the heuristic default. */
  resetFieldOverride: (sourceId: string, column: string) => Promise<void>;
  /** True while the source list is being (re)fetched. */
  listLoading: boolean;
  listError: string | null;
  activate: (id: string) => Promise<void>;
  refreshActive: () => Promise<void>;
  refreshList: () => Promise<void>;
  addServerSource: (input: CreateDataSourceInput) => Promise<DataSourceMeta>;
  /** Re-seal an existing server source's credentials (rotation). */
  rotateSource: (id: string, input: CreateDataSourceInput) => Promise<DataSourceMeta>;
  addFileSource: (file: File) => Promise<void>;
  removeSource: (id: string) => Promise<void>;
  testSource: (id: string) => Promise<ConnectionTestResult>;
  /**
   * Map a source id to HOW the keyed registry should load it (for the dashboard
   * scheduler). Returns null for an unknown/unresolvable id. Does NOT activate
   * the single-source query panel — it only describes the load.
   */
  resolveSpec: (id: string) => SourceSpec | null;
  /** The field schema for a source (for the widget builder). Cached per id. */
  getFields: (id: string) => Promise<Field[]>;
}

export function useDataSources(engine: AnalyticsEngine): DataSourcesApi {
  const [serverSources, setServerSources] = React.useState<DataSourceMeta[]>([]);
  const [localSources, setLocalSources] = React.useState<SourceView[]>([]);
  const [live, setLive] = React.useState<Record<string, LiveState>>({});
  const [fieldsById, setFieldsById] = React.useState<Record<string, Field[]>>({});
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [listLoading, setListLoading] = React.useState(false);
  const [listError, setListError] = React.useState<string | null>(null);

  const overridesStore = React.useMemo(() => getFieldOverridesStore(), []);
  const [overridesById, setOverridesById] = React.useState<Record<string, Record<string, FieldOverride>>>({});
  const loadedOverrideIds = React.useRef<Set<string>>(new Set());

  // File handles live in a ref (handles, not rows — never raw data in state).
  const fileHandles = React.useRef<Map<string, File>>(new Map());

  const patchLive = React.useCallback((id: string, next: Partial<LiveState>) => {
    setLive((prev) => ({ ...prev, [id]: { ...prev[id], ...next } as LiveState }));
  }, []);

  const refreshList = React.useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const res = await fetch("/api/datasources");
      if (!res.ok) throw new Error(`Failed to load sources (${res.status}).`);
      setServerSources((await res.json()) as DataSourceMeta[]);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to load sources.");
    } finally {
      setListLoading(false);
    }
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async load on mount; not derivable during render
    void refreshList();
  }, [refreshList]);

  const activate = React.useCallback(
    async (id: string) => {
      setActiveId(id);
      patchLive(id, { status: "connecting", error: undefined });
      try {
        if (id === DEMO_SOURCE_ID) {
          // Generated client-side and handed straight to the engine — the rows
          // are a transient local, never stored in React state.
          const rowCount = await engine.load(generateSalesData());
          setFieldsById((p) => ({ ...p, [id]: SALES_FIELDS }));
          patchLive(id, { status: "ready", rowCount });
          return;
        }

        const file = fileHandles.current.get(id);
        if (file) {
          const { rowCount, columns } = await engine.loadFile(file);
          setFieldsById((p) => ({ ...p, [id]: fieldsFromColumns(columns) }));
          patchLive(id, { status: "ready", rowCount });
          return;
        }

        // Server source: the worker fetches the bounded slice itself.
        const meta = serverSources.find((s) => s.id === id);
        const { rowCount, columns } = await engine.loadFromSource(id, {
          table: meta?.tableName,
        });
        setFieldsById((p) => ({ ...p, [id]: fieldsFromColumns(columns) }));
        patchLive(id, { status: "ready", rowCount });
      } catch (err) {
        patchLive(id, {
          status: "error",
          error: err instanceof Error ? err.message : "Failed to load source.",
        });
      }
    },
    [engine, patchLive, serverSources],
  );

  const refreshActive = React.useCallback(async () => {
    if (activeId) await activate(activeId);
  }, [activeId, activate]);

  // Load the active source's overrides once (cached thereafter); layered onto
  // `activeFields` below so QueryBuilder/SqlEditor see them automatically.
  React.useEffect(() => {
    if (!activeId || loadedOverrideIds.current.has(activeId)) return;
    loadedOverrideIds.current.add(activeId);
    void overridesStore.get(activeId).then((o) => {
      setOverridesById((p) => ({ ...p, [activeId]: o }));
    });
  }, [activeId, overridesStore]);

  const setFieldOverride = React.useCallback(
    async (sourceId: string, column: string, patch: FieldOverride) => {
      const next = await overridesStore.set(sourceId, column, patch);
      loadedOverrideIds.current.add(sourceId);
      setOverridesById((p) => ({ ...p, [sourceId]: next }));
    },
    [overridesStore],
  );

  const resetFieldOverride = React.useCallback(
    async (sourceId: string, column: string) => {
      const next = await overridesStore.reset(sourceId, column);
      setOverridesById((p) => ({ ...p, [sourceId]: next }));
    },
    [overridesStore],
  );

  const addServerSource = React.useCallback(
    async (input: CreateDataSourceInput) => {
      const res = await fetch("/api/datasources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as { error?: string }).error ?? "Failed to create source.");
      }
      const meta = body as DataSourceMeta;
      setServerSources((prev) => [...prev, meta]);
      return meta;
    },
    [],
  );

  const rotateSource = React.useCallback(
    async (id: string, input: CreateDataSourceInput) => {
      const res = await fetch(`/api/datasources/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as { error?: string }).error ?? "Failed to rotate credentials.");
      }
      const meta = body as DataSourceMeta;
      setServerSources((prev) => prev.map((s) => (s.id === id ? meta : s)));
      return meta;
    },
    [],
  );

  const addFileSource = React.useCallback(
    async (file: File) => {
      const id = crypto.randomUUID();
      fileHandles.current.set(id, file);
      setLocalSources((prev) => [
        ...prev,
        { id, name: file.name, kind: "file", status: "idle", local: true },
      ]);
      await activate(id);
    },
    [activate],
  );

  const removeSource = React.useCallback(
    async (id: string) => {
      if (id === DEMO_SOURCE_ID) return; // built-in is permanent

      if (fileHandles.current.has(id)) {
        fileHandles.current.delete(id);
        setLocalSources((prev) => prev.filter((s) => s.id !== id));
      } else {
        const res = await fetch(`/api/datasources/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!res.ok && res.status !== 404) {
          throw new Error("Failed to remove source.");
        }
        setServerSources((prev) => prev.filter((s) => s.id !== id));
      }

      setLive((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setFieldsById((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setOverridesById((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      loadedOverrideIds.current.delete(id);
      void overridesStore.clear(id);
      if (activeId === id) setActiveId(null);
    },
    [activeId, overridesStore],
  );

  const testSource = React.useCallback(
    async (id: string): Promise<ConnectionTestResult> => {
      patchLive(id, { status: "connecting", error: undefined });
      try {
        const res = await fetch(`/api/datasources/${encodeURIComponent(id)}/test`, {
          method: "POST",
        });
        const result = (await res.json()) as ConnectionTestResult;
        patchLive(id, {
          status: result.ok ? "ready" : "error",
          error: result.ok ? undefined : result.error,
        });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : "Connection test failed.";
        patchLive(id, { status: "error", error });
        return { ok: false, error };
      }
    },
    [patchLive],
  );

  const resolveSpec = React.useCallback(
    (id: string): SourceSpec | null => {
      if (id === DEMO_SOURCE_ID) {
        // Generated client-side and handed straight to a worker (transient —
        // never held in React state), mirroring the query-panel demo path.
        return {
          kind: "rows",
          rows: generateSalesData(),
          columns: SALES_FIELDS.map(fieldToColumn),
        };
      }
      const file = fileHandles.current.get(id);
      if (file) return { kind: "file", file };
      const meta = serverSources.find((s) => s.id === id);
      if (meta) return { kind: "server", sourceId: id, table: meta.tableName };
      return null;
    },
    [serverSources],
  );

  const getFields = React.useCallback(
    async (id: string): Promise<Field[]> => {
      let fields = fieldsById[id];
      if (!fields) {
        if (id === DEMO_SOURCE_ID) {
          fields = SALES_FIELDS;
        } else {
          // Server source: introspect its schema (file schema is only known
          // after a load, which the scheduler does lazily — cached once known).
          try {
            const res = await fetch(`/api/datasources/${encodeURIComponent(id)}/schema`);
            if (!res.ok) return [];
            const schema = (await res.json()) as SourceSchema;
            fields = fieldsFromColumns(schema.columns);
            setFieldsById((p) => ({ ...p, [id]: fields! }));
          } catch {
            return [];
          }
        }
      }
      const overrides = overridesById[id] ?? (await overridesStore.get(id));
      return applyFieldOverrides(fields, overrides);
    },
    [fieldsById, overridesById, overridesStore],
  );

  // Merge the three source classes + overlay live status. Demo first.
  const sources = React.useMemo<SourceView[]>(() => {
    const merge = (s: SourceView): SourceView => {
      const l = live[s.id];
      return l ? { ...s, status: l.status, rowCount: l.rowCount, error: l.error } : s;
    };
    return [
      merge(DEMO_SOURCE),
      ...localSources.map(merge),
      ...serverSources.map((s) => merge(s as SourceView)),
    ];
  }, [localSources, serverSources, live]);

  const activeSource = React.useMemo(
    () => sources.find((s) => s.id === activeId) ?? null,
    [sources, activeId],
  );

  const activeFields = React.useMemo(() => {
    if (!activeId) return [];
    return applyFieldOverrides(fieldsById[activeId] ?? [], overridesById[activeId] ?? {});
  }, [activeId, fieldsById, overridesById]);

  return {
    sources,
    activeId,
    activeSource,
    activeFields,
    fieldOverrides: activeId ? overridesById[activeId] ?? {} : {},
    setFieldOverride,
    resetFieldOverride,
    listLoading,
    listError,
    activate,
    refreshActive,
    refreshList,
    addServerSource,
    rotateSource,
    addFileSource,
    removeSource,
    testSource,
    resolveSpec,
    getFields,
  };
}
