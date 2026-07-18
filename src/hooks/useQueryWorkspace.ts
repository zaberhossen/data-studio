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
  type IrCompileResult,
  type IrDraft,
} from "@/lib/query/ir-draft";
import { compileIR, DuckDbDialect, queryV1ToIR } from "@/lib/query/compile";
import { chooseExecution } from "@/lib/query/compile/route";
import { suggestVizType } from "@/lib/query/suggest-viz";
import { irColumns, isQuerySource, type QueryIR } from "@/lib/query/ir";
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
import { tableNameFor, type SqlColumn } from "@/lib/types/sql";
import { format as formatSql } from "sql-formatter";

// The query panel toggles builder ⇄ advanced (ir) ⇄ sql.
export type WorkspaceMode = Extract<QueryKind, "builder" | "ir" | "sql">;

/** Advanced-query execution setting: `"auto"` lets `chooseExecution` decide. */
export type ExecutionSetting = "auto" | ExecutionMode;

/** The dataset id a pushdown result is ingested under (its own DuckDB table). */
const PUSHDOWN_DATASET = "__pushdown";

/** The dataset id an explored SQL result is promoted under ("GUI on SQL"). */
const EXPLORE_DATASET = "__explore";

/** An active "Explore results" session: the IR builder runs over the promoted
 *  result of a raw SQL statement instead of the active source's dataset. */
export interface ExploreSession {
  /** The statement whose result was promoted (restored by `exitExplore`). */
  sql: string;
  fields: Field[];
  rowCount: number;
}

/** Derive builder `Field[]` from a promoted result's column schema. */
function fieldsFromSqlColumns(columns: SqlColumn[]): Field[] {
  return columns.map((c) => ({
    name: c.name,
    label: c.name,
    role: c.type === "number" ? "metric" : "dimension",
    dataType: c.type === "bool" ? "boolean" : c.type,
  }));
}

/** Source kinds the pushdown endpoint (`/run`) can actually execute against. */
const PUSHDOWN_KINDS: ReadonlySet<DataSourceKind> = new Set(["postgres", "mysql"]);

/** Coerce a stored QueryKind into an editor mode. The advanced (IR) builder is
 *  now the only visual builder, so a legacy `"builder"` record opens there too
 *  (its `ir` is populated by the store's `migrateOnRead`). */
function toWorkspaceMode(kind: QueryKind): WorkspaceMode {
  return kind === "sql" ? "sql" : "ir";
}

/** Force the INNERMOST physical source onto the resident table, preserving any
 *  multi-stage nesting (a nested-query source keeps its shape; only the base
 *  table is rebased). */
function rebaseSource(ir: QueryIR, table: string): QueryIR {
  if (isQuerySource(ir.source)) {
    return { ...ir, source: { ...ir.source, query: rebaseSource(ir.source.query, table) } };
  }
  return { ...ir, source: { table } };
}

/** Compile an IR to self-contained (inlined) SQL for the LOCAL DuckDB path,
 *  forcing the FROM onto the resident table regardless of what was saved. The
 *  allowlist is `irColumns` (the validated IR's own refs) so multi-stage output
 *  columns — not just physical source columns — are permitted. */
function localIrSql(ir: QueryIR, table: string): string {
  const localIr = rebaseSource(ir, table);
  return compileIR(localIr, DuckDbDialect, irColumns(localIr), { inline: true }).sql;
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
  /** `maxRows` caps the whole result set (the SQL page's Limit select). */
  runSql: (sql: string, opts?: { maxRows?: number }) => void;
  /** Run the advanced (IR) builder — LOCAL (inline SQL) or PUSHDOWN per mode. */
  runIr: () => void;
  /**
   * Atomically replace the draft AND run it (drill-through actions) — avoids
   * the set-state → stale `compiledIr` race a setIrDraft+runIr pair would hit.
   */
  applyDraftAndRun: (next: IrDraft) => void;
  /** Reject the in-flight run and best-effort interrupt DuckDB. */
  cancel: () => void;
  /**
   * "Explore results": promote the last SQL run's result set into its own
   * dataset and open the IR builder over it. Available on a settled SQL run.
   */
  exploreResults: () => Promise<void>;
  /** The active explore session, or null (normal source-backed editing). */
  explore: ExploreSession | null;
  /** Leave the explore session and restore the SQL editor + its statement. */
  exitExplore: () => void;
  /**
   * One-way "Convert to SQL" (Metabase-style): compile the current IR to a
   * formatted DuckDB statement, load it into the SQL editor as a new scratch
   * query, and return it (null when the IR doesn't compile).
   */
  convertToSql: () => string | null;
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
  // Explore session ("GUI on SQL"): while active, the builder's fields + table
  // point at the promoted result set instead of the active source's dataset.
  const [explore, setExplore] = React.useState<ExploreSession | null>(null);
  const fields = explore ? explore.fields : sources.activeFields;
  const tableName = explore ? tableNameFor(EXPLORE_DATASET) : engine.tableName;
  const activeId = sources.activeId;
  // Stable (useCallback) engine methods — safe in dependency arrays, unlike the
  // engine object itself (whose identity changes as `loading` toggles).
  const { evictDataset, promoteSqlResult, cancelSql } = engine;

  const [mode, setMode] = React.useState<WorkspaceMode>("ir");
  const [draft, setDraft] = React.useState<QueryDraft>(() => emptyDraft(fields));
  const [irDraft, setIrDraft] = React.useState<IrDraft>(() => emptyIrDraft(fields));
  const [sql, setSql] = React.useState("");
  const [viz, setViz] = React.useState<WidgetViz>({ type: "bar" });
  // Auto-viz: suggest a chart type on Run UNTIL the user picks one themselves
  // (or opens a saved query, whose stored viz is deliberate).
  const vizTouched = React.useRef(false);
  const setVizUser = React.useCallback((next: WidgetViz) => {
    vizTouched.current = true;
    setViz(next);
  }, []);
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
  // NOTE: seeds always come from the SOURCE's fields (not the explore
  // override) — a source switch also tears down any explore session, since the
  // promoted result belonged to the previous source's editing context.
  const sourceFields = sources.activeFields;
  const lastFieldsSourceId = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (sourceFields.length === 0) return;
    const isNewSource = lastFieldsSourceId.current !== activeId;
    lastFieldsSourceId.current = activeId;
    if (isNewSource) setExplore(null);
    setDraft((prev) =>
      isNewSource || !(prev.groupBy || prev.filters.length) ? emptyDraft(sourceFields) : prev,
    );
    setIrDraft((prev) => (isNewSource ? emptyIrDraft(sourceFields) : prev));
    setSql((prev) =>
      isNewSource || !prev.trim() ? sampleSql(sourceFields, engine.tableName) : prev,
    );
  }, [sourceFields, activeId, engine.tableName]);

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
    () => compileIrDraft(irDraft, fields, tableName),
    [irDraft, fields, tableName],
  );

  // ── Advanced-query execution routing (M5) ───────────────────────────────────
  const activeKind = sources.activeSource?.kind;
  // Multi-stage queries (nested-query source) run LOCAL only — the pushdown
  // endpoint rewrites `source` to a physical table, flattening the nesting.
  const multiStage = !!compiledIr.ir && isQuerySource(compiledIr.ir.source);
  // An explore session always runs LOCAL — the promoted result set only exists
  // inside the browser's DuckDB, so pushdown is never applicable.
  const canPushdown =
    !explore && !multiStage && (activeKind ? PUSHDOWN_KINDS.has(activeKind) : false);
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
    // "ir" — the advanced (and now only) visual builder. A non-auto execution
    // setting rides along so reopening restores the toggle (excluded from
    // dirty comparison by `toDefinition`).
    if (!compiledIr.ir) return null;
    return {
      sourceId: activeId,
      queryKind: "ir",
      ir: compiledIr.ir,
      execution: executionMode === "auto" ? undefined : executionMode,
      viz,
    };
  }, [activeId, mode, compiledIr.ir, sql, viz, executionMode]);

  const dirty = React.useMemo(() => {
    if (!open) return false;
    // An open query whose editor is now incomplete counts as modified.
    if (!liveDefinition) return true;
    return !sameDefinition(liveDefinition, open);
  }, [open, liveDefinition]);

  // A definition built over an explore session's promoted table would break on
  // reopen (the table is transient) — saving waits until you're back on a source.
  const canSave = liveDefinition !== null && explore === null;

  const runBuilder = React.useCallback(
    (query: Query) => {
      setRequest({ kind: "builder", query });
      if (activeId) recordRun({ sourceId: activeId, queryKind: "builder", query, viz });
    },
    [activeId, viz, recordRun],
  );
  const runSql = React.useCallback(
    (statement: string, opts?: { maxRows?: number }) => {
      // History records the raw statement; the cap only shapes this run.
      setRequest({ kind: "sql", sql: statement, maxRows: opts?.maxRows });
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
      if (explore) {
        return {
          kind: "sql",
          sql: localIrSql(ir, tableName),
          datasetId: EXPLORE_DATASET,
        };
      }
      if (resolvedExecution === "pushdown" && activeId) {
        return { kind: "pushdown", sourceId: activeId, ir, datasetId: PUSHDOWN_DATASET };
      }
      return { kind: "sql", sql: localIrSql(ir, engine.tableName) };
    },
    [explore, tableName, resolvedExecution, activeId, engine.tableName],
  );

  // Advanced (IR) run — the primary builder. Records the run as an `ir` entry so
  // it re-opens in the builder (not SQL); executes via `requestForIr`. While the
  // user hasn't chosen a chart type, a suggestion derived from the draft's shape
  // is applied (Metabase-style auto-viz).
  const runIr = React.useCallback(() => {
    if (!compiledIr.ir || !activeId) return;
    let effectiveViz = viz;
    if (!vizTouched.current) {
      const suggested = suggestVizType(irDraft, fields);
      if (suggested !== viz.type) {
        effectiveViz = { ...viz, type: suggested };
        setViz(effectiveViz);
      }
    }
    // Explore runs aren't recorded: their IR points at a transient promoted
    // table that won't exist when a history entry tries to re-run it.
    if (!explore) {
      recordRun({ sourceId: activeId, queryKind: "ir", ir: compiledIr.ir, viz: effectiveViz });
    }
    setRequest(requestForIr(compiledIr.ir));
  }, [compiledIr.ir, activeId, viz, irDraft, fields, explore, recordRun, requestForIr]);

  // Drill-through entry point: swap the draft and run in one step. The viz is
  // re-suggested when the query SHAPE flips (aggregated ⇄ raw listing) even if
  // the user picked a type — a bar chart of raw drill-down rows is nonsense.
  const applyDraftAndRun = React.useCallback(
    (next: IrDraft) => {
      setIrDraft(next);
      if (!activeId) return;
      const compiled = compileIrDraft(next, fields, tableName);
      if (!compiled.ir) return;
      const wasAggregated = irDraft.dimensions.length > 0 || irDraft.metrics.length > 0;
      const isAggregated = next.dimensions.length > 0 || next.metrics.length > 0;
      let effectiveViz = viz;
      if (wasAggregated !== isAggregated || !vizTouched.current) {
        const suggested = suggestVizType(next, fields);
        if (suggested !== viz.type) {
          effectiveViz = { ...viz, type: suggested };
          setViz(effectiveViz);
        }
      }
      if (!explore) {
        recordRun({ sourceId: activeId, queryKind: "ir", ir: compiled.ir, viz: effectiveViz });
      }
      setRequest(requestForIr(compiled.ir));
    },
    [activeId, fields, tableName, irDraft, viz, explore, recordRun, requestForIr],
  );

  // ── Open flow ───────────────────────────────────────────────────────────────
  const openSavedQuery = React.useCallback(
    async (target: SavedQuery | SavedQuerySummary) => {
      setOpeningId(target.id);
      setSaveError(null);
      // Any explore session ends — the saved query re-binds to its own source.
      evictDataset(EXPLORE_DATASET);
      setExplore(null);
      try {
        // Always fetch the full record (a summary carries no query/sql payload).
        const sq = "viz" in target ? (target as SavedQuery) : await store.get(target.id);
        if (!sq) throw new Error("Saved query no longer exists.");

        // Restore the editor in the STORED mode + viz + execution setting
        // (builder/ir → the advanced builder; sql → the SQL editor).
        setMode(toWorkspaceMode(sq.queryKind));
        setViz(sq.viz);
        vizTouched.current = true; // stored viz is deliberate
        setExecutionMode(sq.execution ?? "auto");
        // Warm the target source's field cache (hydrates the builder on activate).
        await sources.getFields(sq.sourceId);
        // A legacy "builder" record carries `ir` via the store's migrateOnRead;
        // an "ir" record carries it directly. Both hydrate the advanced builder.
        const ir = sq.queryKind !== "sql" ? sq.ir : undefined;
        if (ir) {
          // Anything the builder can't express is reported, not silently lost.
          const warnings: string[] = [];
          setIrDraft(irToDraft(ir, warnings));
          if (warnings.length > 0) setSaveError(`Note: ${warnings.join(" ")}`);
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

        // 3. Execute through the existing results pipeline, honoring the stored
        // execution setting (resolved against the source's actual capability —
        // the toggle's floor logic, replicated here because state set above
        // hasn't propagated to `resolvedExecution` yet).
        if (ir) {
          const kind = sources.sources.find((s) => s.id === sq.sourceId)?.kind;
          const setting = sq.execution ?? "auto";
          const resolved = setting === "auto" && kind ? chooseExecution(kind, ir) : setting;
          const pushdown = resolved === "pushdown" && kind && PUSHDOWN_KINDS.has(kind);
          setRequest(
            pushdown
              ? { kind: "pushdown", sourceId: sq.sourceId, ir, datasetId: PUSHDOWN_DATASET }
              : { kind: "sql", sql: localIrSql(ir, engine.tableName) },
          );
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
    [store, sources, recordRun, engine.tableName, evictDataset],
  );

  // ── Persist (create / update) ───────────────────────────────────────────────
  const persist = React.useCallback(
    async (input: SaveInput, intent: "save" | "saveAs"): Promise<SavedQuery | null> => {
      if (explore) {
        setSaveError("Saving isn't available while exploring SQL results.");
        return null;
      }
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
        vizTouched.current = true;

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
    [explore, liveDefinition, open, store, refreshList],
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
      evictDataset(EXPLORE_DATASET);
      setExplore(null);
      try {
        setMode(toWorkspaceMode(entry.queryKind));
        setViz(entry.viz);
        vizTouched.current = true;
        await sources.getFields(entry.sourceId);
        // "ir" entries carry `ir`; legacy "builder" entries carry a v1 `query`
        // that we migrate on the fly — both open in the advanced builder.
        const ir =
          entry.queryKind === "ir"
            ? entry.ir
            : entry.queryKind === "builder" && entry.query
              ? queryV1ToIR(entry.query, engine.tableName)
              : undefined;
        if (ir) {
          const warnings: string[] = [];
          setIrDraft(irToDraft(ir, warnings));
          if (warnings.length > 0) setSaveError(`Note: ${warnings.join(" ")}`);
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
          setRequest({ kind: "sql", sql: localIrSql(ir, engine.tableName) });
          recordRun({ sourceId: entry.sourceId, queryKind: "ir", ir, viz: entry.viz });
        } else if (entry.sql?.trim()) {
          setRequest({ kind: "sql", sql: entry.sql });
          recordRun({ sourceId: entry.sourceId, queryKind: "sql", sql: entry.sql, viz: entry.viz });
        }
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to re-run this query.");
      }
    },
    [sources, recordRun, engine.tableName, evictDataset],
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
    evictDataset(EXPLORE_DATASET);
    setExplore(null);
    setOpen(null);
    setMode("ir");
    // Always reset to the SOURCE's fields — never a lingering explore schema.
    setDraft(emptyDraft(sourceFields));
    setIrDraft(emptyIrDraft(sourceFields));
    setSql(sampleSql(sourceFields, engine.tableName));
    setViz({ type: "bar" });
    vizTouched.current = false; // fresh query → auto-viz resumes
    setRequest(null);
    setSaveError(null);
  }, [sourceFields, engine.tableName, evictDataset]);

  // ── Explore results ("GUI on SQL") ─────────────────────────────────────────
  const exploreResults = React.useCallback(async () => {
    if (!request || request.kind !== "sql" || request.datasetId) return;
    setSaveError(null);
    try {
      // Explore what the user SAW: honor the page's row cap, like its display.
      const body = request.sql.trim().replace(/;\s*$/, "");
      const capped = request.maxRows
        ? `SELECT * FROM (\n${body}\n) AS _q LIMIT ${request.maxRows}`
        : request.sql;
      const res = await promoteSqlResult(engine.tableName, capped, EXPLORE_DATASET);
      const exploreFields = fieldsFromSqlColumns(res.columns);
      setExplore({ sql: request.sql, fields: exploreFields, rowCount: res.rowCount });
      setMode("ir");
      setOpen(null);
      setIrDraft(emptyIrDraft(exploreFields));
      setViz({ type: "table" });
      vizTouched.current = false; // shape-driven suggestions resume
      setRequest({
        kind: "sql",
        sql: `SELECT * FROM "${tableNameFor(EXPLORE_DATASET)}"`,
        datasetId: EXPLORE_DATASET,
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : ((err as { message?: string })?.message ?? "Failed to explore results.");
      setSaveError(message);
    }
  }, [request, engine.tableName, promoteSqlResult]);

  const exitExplore = React.useCallback(() => {
    if (!explore) return;
    const sql = explore.sql;
    evictDataset(EXPLORE_DATASET);
    setExplore(null);
    setMode("sql");
    setIrDraft(emptyIrDraft(sourceFields));
    setSql(sql);
    setRequest({ kind: "sql", sql });
  }, [explore, sourceFields, evictDataset]);

  // ── Convert to SQL (one-way, Metabase-style) ───────────────────────────────
  const convertToSql = React.useCallback((): string | null => {
    if (!compiledIr.ir) return null;
    const raw = localIrSql(compiledIr.ir, tableName);
    let pretty = raw;
    try {
      pretty = formatSql(raw, { language: "duckdb", keywordCase: "upper" });
    } catch {
      // The formatter is cosmetic — fall back to the compiler's output.
    }
    setMode("sql");
    setSql(pretty);
    setOpen(null); // a converted query is a new scratch query
    return pretty;
  }, [compiledIr.ir, tableName]);

  const defaultResultView: "chart" | "table" = viz.type === "table" ? "table" : "chart";

  return {
    fields,
    datasetName: explore ? "SQL results" : (sources.activeSource?.name ?? "No source"),
    tableName,
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
    setViz: setVizUser,
    running: engine.loading,
    queryToSql: engine.queryToSql,
    sqlToQuery: engine.sqlToQuery,
    request,
    runBuilder,
    runSql,
    runIr,
    applyDraftAndRun,
    cancel: cancelSql,
    exploreResults,
    explore,
    exitExplore,
    convertToSql,
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
