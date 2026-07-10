"use client";

/**
 * QueryPanel — hosts the Builder ⇄ SQL toggle and the saved-query controls.
 *
 * Two editor modes: **Builder** (the IR-based advanced builder — the only visual
 * builder) and **SQL** (raw DuckDB). Switching modes does NOT translate between
 * them (the IR has no SQL bridge); each mode keeps its own editor state, both
 * controlled by `useQueryWorkspace` so the same live state feeds save + dirty
 * tracking and can be restored by the open flow.
 *
 * The saved-query actions (New / Open / Save / Save as) live in a single ⋯
 * dropdown. Execution (Local / Pushdown) is chosen inside the Builder card, not
 * here — so this toolbar stays narrow inside the fixed query column.
 */

import * as React from "react";
import {
  Code2,
  FilePlus2,
  FolderOpen,
  Layers,
  MoreHorizontal,
  Play,
  Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { QueryWorkspace } from "@/hooks/useQueryWorkspace";
import { AdvancedQueryBuilder } from "./AdvancedQueryBuilder";
import { SqlEditor } from "./SqlEditor";
import { SaveQueryDialog } from "./SaveQueryDialog";

type Mode = "ir" | "sql";

interface QueryPanelProps {
  workspace: QueryWorkspace;
  /** Navigate to the saved-queries browser (the "Open" action). */
  onBrowseSaved?: () => void;
}

/** A friendly default name for a not-yet-saved query. */
function suggestName(mode: Mode): string {
  return mode === "sql" ? "SQL query" : "Advanced query";
}

export function QueryPanel({ workspace, onBrowseSaved }: QueryPanelProps) {
  const {
    fields,
    datasetName,
    tableName,
    mode,
    setMode,
    irDraft,
    setIrDraft,
    compiledIr,
    sql,
    setSql,
    viz,
    running,
    runSql,
    runIr,
    executionMode,
    setExecutionMode,
    resolvedExecution,
    canPushdown,
    open,
    dirty,
    canSave,
    saving,
    saveError,
    persist,
    newQuery,
  } = workspace;

  const [saveOpen, setSaveOpen] = React.useState(false);
  const [saveIntent, setSaveIntent] = React.useState<"save" | "saveAs">("save");

  const switchTo = (next: Mode) => {
    if (next !== mode) setMode(next);
  };

  const openSaveDialog = (intent: "save" | "saveAs") => {
    setSaveIntent(intent);
    setSaveOpen(true);
  };

  const panelMode: Mode = mode === "sql" ? "sql" : "ir";
  const dialogInitialName =
    saveIntent === "saveAs"
      ? open
        ? `${open.name} (copy)`
        : suggestName(panelMode)
      : open?.name ?? suggestName(panelMode);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* ── Saved-query bar ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium" title={open?.name}>
            {open ? open.name : "Unsaved query"}
          </span>
          {open && dirty && (
            <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">
              Modified
            </Badge>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Query actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={newQuery}>
              <FilePlus2 />
              New
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onBrowseSaved?.()}>
              <FolderOpen />
              Open
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!canSave} onSelect={() => openSaveDialog("save")}>
              <Save />
              Save
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canSave} onSelect={() => openSaveDialog("saveAs")}>
              Save as
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* ── Mode toggle ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="tablist"
          aria-label="Query editor mode"
          className="inline-flex rounded-md border border-border bg-muted p-0.5"
        >
          <ModeTab
            active={panelMode === "ir"}
            onClick={() => switchTo("ir")}
            icon={<Layers className="h-3.5 w-3.5" />}
          >
            Builder
          </ModeTab>
          <ModeTab
            active={panelMode === "sql"}
            onClick={() => switchTo("sql")}
            icon={<Code2 className="h-3.5 w-3.5" />}
          >
            SQL
          </ModeTab>
        </div>
        {panelMode === "sql" && (
          <Button
            size="sm"
            className="h-7"
            disabled={sql.trim() === ""}
            onClick={() => runSql(sql)}
          >
            <Play className="h-3.5 w-3.5" />
            Run SQL
          </Button>
        )}
      </div>

      {/* ── Active editor ───────────────────────────────────────────── */}
      <div className="min-h-0 flex-1">
        {panelMode === "ir" ? (
          <AdvancedQueryBuilder
            fields={fields}
            datasetName={datasetName}
            draft={irDraft}
            onDraftChange={setIrDraft}
            compiled={compiledIr}
            onRun={runIr}
            running={running}
            execution={{
              value: executionMode,
              onChange: setExecutionMode,
              resolved: resolvedExecution,
              canPushdown,
            }}
          />
        ) : (
          <SqlEditor value={sql} onChange={setSql} schema={fields} tableName={tableName} />
        )}
      </div>

      <SaveQueryDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        intent={saveIntent}
        hasOpenRecord={!!open}
        initialName={dialogInitialName}
        initialDescription={saveIntent === "save" ? open?.description : undefined}
        initialViz={viz}
        saving={saving}
        error={saveError}
        onSubmit={async (input) => {
          const saved = await persist(input, saveIntent);
          if (saved) setSaveOpen(false);
        }}
      />
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      role="tab"
      aria-selected={active}
      variant={active ? "secondary" : "ghost"}
      size="sm"
      onClick={onClick}
      className="h-7 gap-1.5"
    >
      {icon}
      {children}
    </Button>
  );
}
