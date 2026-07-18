"use client";

/**
 * BuilderView — the /editor page surface (Supabase table-editor chrome + a
 * split view like the SQL editor):
 *   SchemaTree | (toolbar → AdvancedQueryBuilder  |  Results·Chart)
 *
 * Repackages the IR (visual) builder half of the old QueryPanel into its own
 * page. Builder + results are a horizontal ResizableSplit; the ⋯ menu carries
 * New / Open / Save / Save as. All state comes from the hoisted workspace so it
 * persists across navigation.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Code2,
  Compass,
  Copy,
  FilePlus2,
  FolderOpen,
  Layers,
  MoreHorizontal,
  Play,
  Plus,
  Save,
  Square,
  X,
} from "lucide-react";
import { format as formatSql } from "sql-formatter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizableSplit } from "@/components/layout/ResizableSplit";
import { compileIR, DuckDbDialect } from "@/lib/query/compile";
import { irColumns } from "@/lib/query/ir";
import {
  compileIrDraft,
  emptyIrDraft,
  stageOutputFields,
  type IrDraft,
} from "@/lib/query/ir-draft";
import { SchemaTree } from "./SchemaTree";
import { AdvancedQueryBuilder, type PreviewData } from "./AdvancedQueryBuilder";
import type { Field } from "@/lib/query/schema";
import { cn } from "@/lib/utils";
import { ExecutionModeToggle } from "./ExecutionModeToggle";
import { SaveQueryDialog } from "./SaveQueryDialog";
import { ResultsRegion } from "@/components/results/ResultsRegion";
import { useEngine, useWorkspace } from "@/app/(app)/WorkspaceProvider";

export function BuilderView() {
  const router = useRouter();
  const engine = useEngine();
  const ws = useWorkspace();

  const [saveOpen, setSaveOpen] = React.useState(false);
  const [saveIntent, setSaveIntent] = React.useState<"save" | "saveAs">("save");

  // Per-step preview runner: compile the truncated draft to inline DuckDB SQL
  // and pull one bounded 10-row page from the worker (rows never enter state).
  const { runSql } = engine;
  const { fields, tableName } = ws;
  const runPreview = React.useCallback(
    async (draft: IrDraft): Promise<PreviewData> => {
      const compiled = compileIrDraft(draft, fields, tableName, { allowBare: true });
      if (!compiled.ir) {
        throw new Error(compiled.errors[0] ?? "This step doesn't compile yet.");
      }
      const { sql } = compileIR(compiled.ir, DuckDbDialect, irColumns(compiled.ir), {
        inline: true,
      });
      const r = await runSql(sql, { limit: 10, offset: 0 });
      return { columns: r.columns.map((c) => c.name), rows: r.rows.slice(0, 10) };
    },
    [fields, tableName, runSql],
  );

  const openSaveDialog = (intent: "save" | "saveAs") => {
    setSaveIntent(intent);
    setSaveOpen(true);
  };

  // "View SQL": the current IR compiled + pretty-printed (null = dialog closed).
  const [sqlPreview, setSqlPreview] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const openViewSql = () => {
    if (!ws.compiledIr.ir) return;
    const { sql } = compileIR(ws.compiledIr.ir, DuckDbDialect, irColumns(ws.compiledIr.ir), {
      inline: true,
    });
    let pretty = sql;
    try {
      pretty = formatSql(sql, { language: "duckdb", keywordCase: "upper" });
    } catch {
      // formatter is cosmetic
    }
    setCopied(false);
    setSqlPreview(pretty);
  };
  const copyPreview = async () => {
    if (!sqlPreview) return;
    await navigator.clipboard.writeText(sqlPreview);
    setCopied(true);
  };
  const editAsSql = () => {
    if (ws.convertToSql() !== null) {
      setSqlPreview(null);
      router.push("/sql");
    }
  };

  const dialogInitialName =
    saveIntent === "saveAs"
      ? ws.open
        ? `${ws.open.name} (copy)`
        : "Advanced query"
      : ws.open?.name ?? "Advanced query";

  return (
    <div className="flex h-full min-h-0">
      <SchemaTree />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="truncate text-sm font-medium" title={ws.open?.name}>
            {ws.open ? ws.open.name : "Untitled query"}
          </span>
          {ws.open && ws.dirty && <Badge variant="warning">Modified</Badge>}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Query actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => ws.newQuery()}>
                <FilePlus2 />
                New
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => router.push("/saved")}>
                <FolderOpen />
                Open
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!ws.canSave} onSelect={() => openSaveDialog("save")}>
                <Save />
                Save
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!ws.canSave} onSelect={() => openSaveDialog("saveAs")}>
                Save as
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={ws.compiledIr.ir === null} onSelect={openViewSql}>
                <Code2 />
                View SQL
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="ml-auto flex items-center gap-3">
            <ExecutionModeToggle
              value={ws.executionMode}
              onChange={ws.setExecutionMode}
              resolved={ws.resolvedExecution}
              canPushdown={ws.canPushdown}
            />
            <span className="hidden text-xs text-muted-foreground lg:inline">
              Visual query builder
            </span>
            {ws.running ? (
              <Button variant="outline" size="sm" className="h-8" onClick={() => ws.cancel()}>
                <Square className="h-3 w-3 fill-current" />
                Cancel
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-8"
                disabled={ws.compiledIr.ir === null}
                onClick={ws.runIr}
              >
                <Play className="h-3.5 w-3.5" />
                Run
              </Button>
            )}
          </div>
        </div>

        {/* Explore-results session banner ("GUI on SQL") */}
        {ws.explore && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-100 px-3 py-1.5">
            <Compass className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              Exploring SQL results ({ws.explore.rowCount.toLocaleString()} rows) — this
              session is temporary and can&apos;t be saved.
            </span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7"
              onClick={ws.exitExplore}
            >
              Back to SQL
            </Button>
          </div>
        )}

        {/* Builder / results split */}
        <div className="min-h-0 flex-1 p-3">
          <ResizableSplit
            orientation="vertical"
            className="h-full"
            defaultSize={55}
            first={
              <div className="h-full overflow-auto pb-3">
                <StagesEditor
                  fields={ws.fields}
                  datasetName={ws.datasetName}
                  tableName={ws.tableName}
                  draft={ws.irDraft}
                  onDraftChange={ws.setIrDraft}
                  onPreview={runPreview}
                />
              </div>
            }
            second={
              <div className="h-full pt-3">
                <ResultsRegion
                  engine={engine}
                  request={ws.request}
                  defaultView={ws.defaultResultView}
                  viz={ws.viz}
                  onResult={ws.recordResult}
                  onVizChange={ws.setViz}
                  drill={{
                    draft: ws.irDraft,
                    fields: ws.fields,
                    apply: ws.applyDraftAndRun,
                  }}
                />
              </div>
            }
          />
        </div>
      </div>

      {/* View SQL — the compiled statement behind the current builder state */}
      <Dialog open={sqlPreview !== null} onOpenChange={(o) => !o && setSqlPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>SQL for this query</DialogTitle>
            <DialogDescription>
              The statement the builder compiles to (DuckDB dialect, values inlined).
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-80 overflow-auto rounded-md border border-border bg-surface-100 p-3 font-mono text-xs leading-relaxed">
            {sqlPreview}
          </pre>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => void copyPreview()}>
              <Copy className="h-3.5 w-3.5" />
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button size="sm" onClick={editAsSql} title="One-way: opens this statement in the SQL editor">
              Edit as SQL
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SaveQueryDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        intent={saveIntent}
        hasOpenRecord={!!ws.open}
        initialName={dialogInitialName}
        initialDescription={saveIntent === "save" ? ws.open?.description : undefined}
        initialViz={ws.viz}
        saving={ws.saving}
        error={ws.saveError}
        onSubmit={async (input) => {
          const saved = await ws.persist(input, saveIntent);
          if (saved) setSaveOpen(false);
        }}
      />
    </div>
  );
}

/**
 * StagesEditor — renders the notebook as one or more STAGES. Stage 1 is the base
 * query (`draft`); an optional second stage (`draft.nextStage`) runs over stage
 * 1's OUTPUT columns and compiles to a nested-query subquery (multi-stage).
 * Stage 1 rides its `nextStage` along untouched (the builder patches the draft),
 * so we hand it the whole draft and derive the stage-2 schema from it.
 */
function StagesEditor({
  fields,
  datasetName,
  tableName,
  draft,
  onDraftChange,
  onPreview,
}: {
  fields: Field[];
  datasetName: string;
  tableName: string;
  draft: IrDraft;
  onDraftChange: (draft: IrDraft) => void;
  onPreview: (draft: IrDraft) => Promise<PreviewData>;
}) {
  const nextStage = draft.nextStage;

  // Stage-1-only compile result for the base builder's validation summary (so a
  // stage-2 error doesn't surface under stage 1).
  const stage1Compiled = React.useMemo(
    () => compileIrDraft({ ...draft, nextStage: undefined }, fields, tableName),
    [draft, fields, tableName],
  );

  // Stage 2 builds against stage 1's output columns.
  const stage2Fields = React.useMemo(() => stageOutputFields(draft, fields), [draft, fields]);
  const stage2Compiled = React.useMemo(
    () => (nextStage ? compileIrDraft(nextStage, stage2Fields, "__stage") : null),
    [nextStage, stage2Fields],
  );

  const aggregates = draft.metrics.length > 0 || draft.dimensions.length > 0;

  const addStage = () => onDraftChange({ ...draft, nextStage: emptyIrDraft(stage2Fields) });
  const removeStage = () => {
    const next = { ...draft };
    delete next.nextStage;
    onDraftChange(next);
  };
  const setNextStage = (ns: IrDraft) => onDraftChange({ ...draft, nextStage: ns });

  return (
    <div className="space-y-3">
      <StageCard label={nextStage ? "Stage 1" : undefined} badge={datasetName}>
        <AdvancedQueryBuilder
          chromeless
          fields={fields}
          datasetName={datasetName}
          draft={draft}
          onDraftChange={onDraftChange}
          compiled={stage1Compiled}
          onPreview={onPreview}
        />
      </StageCard>

      {nextStage ? (
        <StageCard label="Stage 2" badge="over Stage 1 output" onRemove={removeStage}>
          <AdvancedQueryBuilder
            chromeless
            fields={stage2Fields}
            datasetName="Stage 1 output"
            draft={nextStage}
            onDraftChange={setNextStage}
            compiled={stage2Compiled!}
          />
        </StageCard>
      ) : (
        aggregates && (
          <button
            type="button"
            onClick={addStage}
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border",
              "py-2.5 text-xs font-medium text-muted-foreground transition-colors",
              "hover:border-brand/50 hover:text-brand-600 dark:hover:text-brand-400",
            )}
            title="Summarize or filter these results again in a second stage"
          >
            <Plus className="h-3.5 w-3.5" />
            Add a stage — summarize these results again
          </button>
        )
      )}
    </div>
  );
}

/** A labelled frame around one stage's notebook (only shown once a 2nd stage exists). */
function StageCard({
  label,
  badge,
  onRemove,
  children,
}: {
  label?: string;
  badge?: string;
  onRemove?: () => void;
  children: React.ReactNode;
}) {
  if (!label) return <>{children}</>;
  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-surface-100 px-3 py-1.5">
        <Layers className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">{label}</span>
        {badge && (
          <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {badge}
          </span>
        )}
        {onRemove && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-6 w-6"
            onClick={onRemove}
            aria-label="Remove stage"
            title="Remove this stage"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="p-2">{children}</div>
    </div>
  );
}
