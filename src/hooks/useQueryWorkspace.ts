"use client";

/**
 * useQueryWorkspace — the query panel's session brain.
 *
 * It owns the editor state that used to live inside `QueryPanel` (mode, builder
 * draft, SQL text, viz) PLUS the saved-query session layered on top of it:
 * which saved query is open, whether the live editor has drifted from it
 * (dirty), and the create/update/open/rename/duplicate/delete actions against
 * the pluggable `SavedQueryStore`.
 *
 * Lifting this state up lets ONE workspace instance feed both the query panel
 * (edit + save) and the saved-queries browser (list + open), and lets the OPEN
 * flow reuse the whole existing pipeline: activate the source (== ensureResident
 * for the single-source panel), restore the stored mode + viz, then run through
 * the existing results region. No new execution path is introduced.
 *
 * It never holds rows or results — only the small declarative definition + the
 * `ResultRequest` the results region materializes.
 */

import * as React from "react";
import type { AnalyticsEngine } from "@/hooks/useAnalyticsEngine";
import type { DataSourcesApi } from "@/hooks/useDataSources";
import type { ResultRequest } from "@/components/results/ResultsRegion";
import type { Query } from "@/lib/types/analytics";
import {
  emptyDraft,
  sampleSql,
  type Field,
  type QueryDraft,
} from "@/lib/query/schema";
import {
  compileIrDraft,
  emptyIrDraft,
  irToDraft,
  allowlistFromFields,
  type IrCompileResult,
  type IrDraft,
} from "@/lib/query/ir-draft";
import { compileIR, DuckDbDialect, queryV1ToIR } from "@/lib/query/compile";
import { chooseExecution } from "@/lib/query/compile/route";
import type { QueryIR } from "@/lib/query/ir";
import type { DataSourceKind } from "@/lib/types/datasource";
import type {
  ExecutionMode,
  QueryDefinition,
  QueryKind,
  SavedQuery,
  WidgetViz,
} from "@/lib/types/query";
import {
  getSavedQueryStore,
  type SavedQueryStore,
  type SavedQuerySummary,
} from "@/lib/saved-queries/store";
import { sameDefinition, toDefinition } from "@/lib/saved-queries/dirty";
import { addDefinitionToDashboard } from "@/lib/dashboard/quick-add";
import {
  getHistoryStore,
  type HistoryEntry,
  type HistoryStore,
  type NewHistoryEntry,
} from "@/lib/history/store";

// The query panel toggles builder ⇄ advanced (ir) ⇄ sql.
export type WorkspaceMode = Extract<QueryKind, "builder" | "ir" | "sql">;

/** Advanced-query execution setting: `"auto"` lets `chooseExecution` decide. */
export type ExecutionSetting = "auto" | ExecutionMode;

/** The dataset id a pushdown result is ingested under (its own DuckDB table). */
const PUSHDOWN_DATASET = "__pushdown";

/** Source kinds the pushdown endpoint (`/run`) can actually execute against. */
const PUSHDOWN_KINDS: ReadonlySet<DataSourceKind> = new Set(["postgres", "mysql"]);

/** Coerce a stored QueryKind into an editor mode. The advanced (IR) builder is
 *  now the only visual builder, so a legacy `"builder"` record opens there too
 *  (its `ir` is populated by the store's `migrateOnRead`). */
function toWorkspaceMode(kind: QueryKind): WorkspaceMode {
  return kind === "sql" ? "sql" : "ir";
}

/** Compile an IR to self-contained (inlined) SQL for the LOCAL DuckDB path,
 *  forcing the FROM onto the resident table regardless of what was saved. */
function localIrSql(ir: QueryIR, fields: Field[], table: string): string {
  const localIr: QueryIR = { ...ir, source: { table } };
  return compileIR(localIr, DuckDbDialect, allowlistFromFields(fields), { inline: true }).sql;
}

/** What a save dialog collects; the definition itself comes from live state. */
export interface SaveInput {
  name: string;
  description?: string;
  viz: WidgetViz;
}

export interface QueryWorkspace {
  // ── Editor state (query panel is controlled by these) ──────────────────────
  fields: Field[];
  datasetName: string;
  tableName: string;
  mode: WorkspaceMode;
  setMode: (mode: WorkspaceMode) => void;
  draft: QueryDraft;
  setDraft: React.Dispatch<React.SetStateAction<QueryDraft>>;
  /** Advanced (IR) builder draft + its live compile result. */
  irDraft: IrDraft;
  setIrDraft: React.Dispatch<React.SetStateAction<IrDraft>>;
  compiledIr: IrCompileResult;
  sql: string;
  setSql: (sql: string) => void;
  viz: WidgetViz;
  setViz: (viz: WidgetViz) => void;
  running: boolean;
  queryToSql: AnalyticsEngine["queryToSql"];
  sqlToQuery: AnalyticsEngine["sqlToQuery"];

  // ── Execution (existing pipeline: sets the results-region request) ──────────
  request: ResultRequest | null;
  runBuilder: (query: Query) => void;
  runSql: (sql: string) => void;
  /** Run the advanced (IR) builder — LOCAL (inline SQL) or PUSHDOWN per mode. */
  runIr: () => void;
  /** Advanced-query execution setting (auto / force local / force pushdown). */
  executionMode: ExecutionSetting;
  setExecutionMode: (mode: ExecutionSetting) => void;
  /** The mode a run will ACTUALLY use given the setting + source + current IR. */
  resolvedExecution: ExecutionMode;
  /** Whether the active source supports pushdown (a live postgres/mysql DB). */
  canPushdown: boolean;
  /** "chart" | "table" — which results view to show first, derived from viz. */
  defaultResultView: "chart" | "table";

  // ── Saved-query session ─────────────────────────────────────────────────────
  /** The currently-open saved query, or null (unsaved scratch query). */
  open: SavedQuery | null;
  /** The live definition, or null when incomplete (invalid builder / empty SQL). */
  liveDefinition: QueryDefinition | null;
  /** True when there's an open query and the live editor has drifted from it. */
  dirty: boolean;
  /** Whether the current editor state is complete enough to save. */
  canSave: boolean;

  // ── Browser data ────────────────────────────────────────────────────────────
  list: SavedQuerySummary[];
  listLoading: boolean;
  listError: string | null;
  refreshList: () => Promise<void>;

  // ── Run history (the Results panel) ─────────────────────────────────────────
  historyList: HistoryEntry[];
  historyLoading: boolean;
  /** Called by ResultsRegion once a run settles, to attach stats to its entry. */
  recordResult: (info: {
    status: "data" | "empty" | "error";
    rowCount?: number;
    elapsedMs?: number;
    error?: string;
  }) => void;
  refreshHistory: () => Promise<void>;
  /** Re-run a past entry: activate its source, restore mode + query/sql + viz. */
  openHistoryEntry: (entry: HistoryEntry) => Promise<void>;
  removeHistoryEntry: (id: string) => Promise<void>;
  clearHistory: () => Promise<void>;

  // ── Async status for the save/open UI ──────────────────────────────────────
  saving: boolean;
  saveError: string | null;
  openingId: string | null;

  // ── Actions ─────────────────────────────────────────────────────────────────
  /**
   * Persist the live definition. `intent: "save"` updates the open record (or
   * creates one if none is open); `"saveAs"` always creates a new record.
   */
  persist: (input: SaveInput, intent: "save" | "saveAs") => Promise<SavedQuery | null>;
  /** Open a saved query: activate its source, restore mode + viz, then run it. */
  openSavedQuery: (sq: SavedQuery | SavedQuerySummary) => Promise<void>;
  renameSaved: (id: string, name: string) => Promise<void>;
  duplicateSaved: (id: string) => Promise<SavedQuery | null>;
  removeSaved: (id: string) => Promise<void>;
  /**
   * Build a widget from a saved query's definition and drop it on the default
   * dashboard's next free slot. Resolves the dashboard's new widget count.
   */
  addToDashboard: (id: string) => Promise<number | null>;
  /** Detach from any open record and reset the editor to a blank query. */
  newQuery: () => void;
}

export function useQueryWorkspace(
  engine: AnalyticsEngine,
  sources: DataSourcesApi,
): QueryWorkspace {
  const store = React.useMemo<SavedQueryStore>(() => getSavedQueryStore(), []);
  const historyStore = React.useMemo<HistoryStore>(() => getHistoryStore(), []);
  const fields = sources.activeFields;
  const activeId = sources.activeId;

  const [mode, setMode] = React.useState<WorkspaceMode>("ir");
  const [draft, setDraft] = React.useState<QueryDraft>(() => emptyDraft(fields));
  const [irDraft, setIrDraft] = React.useState<IrDraft>(() => emptyIrDraft(fields));
  const [sql, setSql] = React.useState("");
  const [viz, setViz] = React.useState<WidgetViz>({ type: "bar" });
  const [request, setRequest] = React.useState<ResultRequest | null>(null);
  const [executionMode, setExecutionMode] = React.useState<ExecutionSetting>("auto");

  const [open, setOpen] = React.useState<SavedQuery | null>(null);
  const [list, setList] = React.useState<SavedQuerySummary[]>([]);
  const [listLoading, setListLoading] = React.useState(false);
  const [listError, setListError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [openingId, setOpeningId] = React.useState<string | null>(null);

  const [historyList, setHistoryList] = React.useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const lastHistoryId = React.useRef<string | null>(null);

  // Seed the builder draft + SQL editor once real fields arrive — mirrors
  // AddWidgetDialog: fill defaults into a still-blank editor, never clobber
  // user/opened edits. EXCEPT when the active source itself changed: a draft
  // built against the PREVIOUS source's columns (e.g. `metricColumn: "revenue"`)
  // is invalid for a new schema that doesn't have that column at all, so a
  // source switch forces a reset instead of just "fill if blank" — otherwise
  // compiling the stale draft fails with "Unknown metric/group-by column".
  const lastFieldsSourceId = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (fields.length === 0) return;
    const isNewSource = lastFieldsSourceId.current !== activeId;
    lastFieldsSourceId.current = activeId;
    setDraft((prev) =>
      isNewSource || !(prev.groupBy || prev.filters.length) ? emptyDraft(fields) : prev,
    );
    setIrDraft((prev) => (isNewSource ? emptyIrDraft(fields) : prev));
    setSql((prev) =>
      isNewSource || !prev.trim() ? sampleSql(fields, engine.tableName) : prev,
    );
  }, [fields, activeId, engine.tableName]);

  const refreshList = React.useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      setList(await store.list());
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to load saved queries.");
    } finally {
      setListLoading(false);
    }
  }, [store]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async load on mount; not derivable during render
    void refreshList();
  }, [refreshList]);

  const refreshHistory = React.useCallback(async () => {
    setHistoryLoading(true);
    try {
      setHistoryList(await historyStore.list());
    } finally {
      setHistoryLoading(false);
    }
  }, [historyStore]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async load on mount; not derivable during render
    void refreshHistory();
  }, [refreshHistory]);

  // Record a run the instant it's launched (status "running"); `recordResult`
  // patches it with stats once ResultsRegion's execution settles.
  const recordRun = React.useCallback(
    (def: NewHistoryEntry) => {
      lastHistoryId.current = null;
      void historyStore.record(def).then((entry) => {
        lastHistoryId.current = entry.id;
        void refreshHistory();
      });
    },
    [historyStore, refreshHistory],
  );

  const recordResult = React.useCallback<QueryWorkspace["recordResult"]>(
    (info) => {
      const id = lastHistoryId.current;
      if (!id) return;
      void historyStore
        .patch(id, {
          status: info.status === "error" ? "error" : "ok",
          rowCount: info.rowCount,
          elapsedMs: info.elapsedMs,
          errorMessage: info.error,
        })
        .then(refreshHistory);
    },
    [historyStore, refreshHistory],
  );

  // The compiled advanced (IR) query — validated against the active dataset,
  // targeting the resident local table so it can run through the SQL path.
  const compiledIr = React.useMemo<IrCompileResult>(
    () => compileIrDraft(irDraft, fields, engine.tableName),
    [irDraft, fields, engine.tableName],
  );

  // ── Advanced-query execution routing (M5) ───────────────────────────────────
  const activeKind = sources.activeSource?.kind;
  const canPushdown = activeKind ? PUSHDOWN_KINDS.has(activeKind) : false;
  // What "auto" would pick for the current source + IR (defaults local).
  const autoExecution = React.useMemo<ExecutionMode>(
    () => (activeKind && compiledIr.ir ? chooseExecution(activeKind, compiledIr.ir) : "local"),
    [activeKind, compiledIr.ir],
  );
  // The setting resolved, then floored to what the source can actually do — a
  // forced/auto "pushdown" on a non-live source silently falls back to local.
  const resolvedExecution: ExecutionMode =
    (executionMode === "auto" ? autoExecution : executionMode) === "pushdown" && canPushdown
      ? "pushdown"
      : "local";

  // The live definition — null when the editor isn't complete enough to run/save.
  const liveDefinition = React.useMemo<QueryDefinition | null>(() => {
    if (!activeId) return null;
    if (mode === "sql") {
      if (!sql.trim()) return null;
      return { sourceId: activeId, queryKind: "sql", sql, viz };
    }
    // "ir" — the advanced (and now only) visual builder.
    if (!compiledIr.ir) return null;
    return { sourceId: activeId, queryKind: "ir", ir: compiledIr.ir, viz };
  }, [activeId, mode, compiledIr.ir, sql, viz]);

  const dirty = React.useMemo(() => {
    if (!open) return false;
    // An open query whose editor is now incomplete counts as modified.
    if (!liveDefinition) return true;
    return !sameDefinition(liveDefinition, open);
  }, [open, liveDefinition]);

  const canSave = liveDefinition !== null;

  const runBuilder = React.useCallback(
    (query: Query) => {
      setRequest({ kind: "builder", query });
      if (activeId) recordRun({ sourceId: activeId, queryKind: "builder", query, viz });
    },
    [activeId, viz, recordRun],
  );
  const runSql = React.useCallback(
    (statement: string) => {
      setRequest({ kind: "sql", sql: statement });
      if (activeId) recordRun({ sourceId: activeId, queryKind: "sql", sql: statement, viz });
    },
    [activeId, viz, recordRun],
  );

  // Build the results request for an IR, honoring the resolved execution mode:
  //   • PUSHDOWN → hand the IR to the results region, which runs it on the live
  //                DB server-side (worker fetch) and ingests the result.
  //   • LOCAL    → compile to self-contained (inlined) SQL over the resident table.
  const requestForIr = React.useCallback(
    (ir: QueryIR): ResultRequest => {
      if (resolvedExecution === "pushdown" && activeId) {
        return { kind: "pushdown", sourceId: activeId, ir, datasetId: PUSHDOWN_DATASET };
      }
      return { kind: "sql", sql: localIrSql(ir, fields, engine.tableName) };
    },
    [resolvedExecution, activeId, fields, engine.tableName],
  );

  // Advanced (IR) run — the primary builder. Records the run as an `ir` entry so
  // it re-opens in the builder (not SQL); executes via `requestForIr`.
  const runIr = React.useCallback(() => {
    if (!compiledIr.ir || !activeId) return;
    recordRun({ sourceId: activeId, queryKind: "ir", ir: compiledIr.ir, viz });
    setRequest(requestForIr(compiledIr.ir));
  }, [compiledIr.ir, activeId, viz, recordRun, requestForIr]);

  // ── Open flow ───────────────────────────────────────────────────────────────
  const openSavedQuery = React.useCallback(
    async (target: SavedQuery | SavedQuerySummary) => {
      setOpeningId(target.id);
      setSaveError(null);
      try {
        // Always fetch the full record (a summary carries no query/sql payload).
        const sq = "viz" in target ? (target as SavedQuery) : await store.get(target.id);
        if (!sq) throw new Error("Saved query no longer exists.");

        // Restore the editor in the STORED mode + viz (builder/ir → the advanced
        // builder; sql → the SQL editor).
        setMode(toWorkspaceMode(sq.queryKind));
        setViz(sq.viz);
        // Field schema for the target source (cached) — hydrates the builder.
        const targetFields = await sources.getFields(sq.sourceId);
        // A legacy "builder" record carries `ir` via the store's migrateOnRead;
        // an "ir" record carries it directly. Both hydrate the advanced builder.
        const ir = sq.queryKind !== "sql" ? sq.ir : undefined;
        if (ir) {
          setIrDraft(irToDraft(ir));
          setSql("");
        } else {
          setSql(sq.sql ?? "");
        }
        // A legacy builder record opens as IR — normalize `open` to the IR shape
        // so dirty tracking compares IR-to-IR (not builder-to-IR → always dirty).
        setOpen(ir ? { ...sq, queryKind: "ir", ir, query: undefined } : sq);
        // Tell the field-seeding effect this source switch is already handled
        // (draft/sql just restored above) — otherwise it treats the upcoming
        // `activate`-driven fields update as a fresh source and resets them.
        lastFieldsSourceId.current = sq.sourceId;

        // 1. ensureResident: the single-source panel loads under DATASET_TABLE.
        await sources.activate(sq.sourceId);

        // 3. Execute through the existing results pipeline (IR runs LOCAL on open).
        if (ir) {
          setRequest({ kind: "sql", sql: localIrSql(ir, targetFields, engine.tableName) });
          recordRun({ sourceId: sq.sourceId, queryKind: "ir", ir, viz: sq.viz });
        } else if (sq.sql?.trim()) {
          setRequest({ kind: "sql", sql: sq.sql });
          recordRun({ sourceId: sq.sourceId, queryKind: "sql", sql: sq.sql, viz: sq.viz });
        } else {
          setRequest(null);
        }
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to open saved query.");
      } finally {
        setOpeningId(null);
      }
    },
    [store, sources, recordRun, engine.tableName],
  );

  // ── Persist (create / update) ───────────────────────────────────────────────
  const persist = React.useCallback(
    async (input: SaveInput, intent: "save" | "saveAs"): Promise<SavedQuery | null> => {
      if (!liveDefinition) {
        setSaveError("Finish the query before saving.");
        return null;
      }
      setSaving(true);
      setSaveError(null);
      try {
        // Honor the viz chosen in the dialog for the persisted record + editor.
        const def: QueryDefinition = { ...liveDefinition, viz: input.viz };
        setViz(input.viz);

        let saved: SavedQuery;
        if (intent === "save" && open) {
          saved = await store.update(open.id, {
            ...def,
            name: input.name,
            description: input.description,
          });
        } else {
          saved = await store.create(def, input.name, input.description);
        }
        setOpen(saved);
        await refreshList();
        return saved;
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to save query.");
        return null;
      } finally {
        setSaving(false);
      }
    },
    [liveDefinition, open, store, refreshList],
  );

  const renameSaved = React.useCallback(
    async (id: string, name: string) => {
      const updated = await store.rename(id, name);
      setOpen((cur) => (cur && cur.id === id ? updated : cur));
      await refreshList();
    },
    [store, refreshList],
  );

  const duplicateSaved = React.useCallback(
    async (id: string): Promise<SavedQuery | null> => {
      const src = await store.get(id);
      if (!src) return null;
      const copy = await store.create(
        {
          sourceId: src.sourceId,
          queryKind: src.queryKind,
          query: src.query,
          ir: src.ir,
          sql: src.sql,
          viz: src.viz,
        },
        `${src.name} (copy)`,
        src.description,
      );
      await refreshList();
      return copy;
    },
    [store, refreshList],
  );

  const removeSaved = React.useCallback(
    async (id: string) => {
      await store.remove(id);
      setOpen((cur) => (cur && cur.id === id ? null : cur));
      await refreshList();
    },
    [store, refreshList],
  );

  // ── History actions ─────────────────────────────────────────────────────────
  const openHistoryEntry = React.useCallback(
    async (entry: HistoryEntry) => {
      setSaveError(null);
      try {
        setMode(toWorkspaceMode(entry.queryKind));
        setViz(entry.viz);
        const targetFields = await sources.getFields(entry.sourceId);
        // "ir" entries carry `ir`; legacy "builder" entries carry a v1 `query`
        // that we migrate on the fly — both open in the advanced builder.
        const ir =
          entry.queryKind === "ir"
            ? entry.ir
            : entry.queryKind === "builder" && entry.query
              ? queryV1ToIR(entry.query, engine.tableName)
              : undefined;
        if (ir) {
          setIrDraft(irToDraft(ir));
          setSql("");
        } else {
          setSql(entry.sql ?? "");
        }
        setOpen(null);
        // See openSavedQuery: mark this source as already handled so the
        // field-seeding effect doesn't reset the draft/sql we just restored.
        lastFieldsSourceId.current = entry.sourceId;

        await sources.activate(entry.sourceId);

        if (ir) {
          setRequest({ kind: "sql", sql: localIrSql(ir, targetFields, engine.tableName) });
          recordRun({ sourceId: entry.sourceId, queryKind: "ir", ir, viz: entry.viz });
        } else if (entry.sql?.trim()) {
          setRequest({ kind: "sql", sql: entry.sql });
          recordRun({ sourceId: entry.sourceId, queryKind: "sql", sql: entry.sql, viz: entry.viz });
        }
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to re-run this query.");
      }
    },
    [sources, recordRun, engine.tableName],
  );

  const removeHistoryEntry = React.useCallback(
    async (id: string) => {
      await historyStore.remove(id);
      await refreshHistory();
    },
    [historyStore, refreshHistory],
  );

  const clearHistory = React.useCallback(async () => {
    await historyStore.clear();
    await refreshHistory();
  }, [historyStore, refreshHistory]);

  const addToDashboard = React.useCallback(
    async (id: string): Promise<number | null> => {
      const sq = await store.get(id);
      if (!sq) return null;
      const dashboard = await addDefinitionToDashboard(sq.name, toDefinition(sq));
      return dashboard.widgets.length;
    },
    [store],
  );

  const newQuery = React.useCallback(() => {
    setOpen(null);
    setMode("ir");
    setDraft(emptyDraft(fields));
    setIrDraft(emptyIrDraft(fields));
    setSql(sampleSql(fields, engine.tableName));
    setViz({ type: "bar" });
    setRequest(null);
    setSaveError(null);
  }, [fields, engine.tableName]);

  const defaultResultView: "chart" | "table" = viz.type === "table" ? "table" : "chart";

  return {
    fields,
    datasetName: sources.activeSource?.name ?? "No source",
    tableName: engine.tableName,
    mode,
    setMode,
    draft,
    setDraft,
    irDraft,
    setIrDraft,
    compiledIr,
    sql,
    setSql,
    viz,
    setViz,
    running: engine.loading,
    queryToSql: engine.queryToSql,
    sqlToQuery: engine.sqlToQuery,
    request,
    runBuilder,
    runSql,
    runIr,
    executionMode,
    setExecutionMode,
    resolvedExecution,
    canPushdown,
    defaultResultView,
    open,
    liveDefinition,
    dirty,
    canSave,
    list,
    listLoading,
    listError,
    refreshList,
    historyList,
    historyLoading,
    recordResult,
    refreshHistory,
    openHistoryEntry,
    removeHistoryEntry,
    clearHistory,
    saving,
    saveError,
    openingId,
    persist,
    openSavedQuery,
    renameSaved,
    duplicateSaved,
    removeSaved,
    addToDashboard,
    newQuery,
  };
}
