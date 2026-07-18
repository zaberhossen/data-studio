"use client";

/**
 * SqlEditorView — the /sql page surface (Supabase SQL editor style):
 *   SqlSidebar | (toolbar → CodeMirror  /  Results·Chart split)
 *
 * Repackages the raw-SQL half of the old QueryPanel into a full page. The toolbar
 * carries an autosave hint, a ⋯ actions menu (New / Open / Save / Save as), a
 * functional Source picker, a Limit select (caps the whole result via an outer
 * LIMIT wrap), and a green Run button (also bound to ⌘/Ctrl+Enter in the editor).
 * Editor + results are a vertical ResizableSplit; both are controlled by the
 * hoisted workspace so state persists across navigation.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Compass,
  CornerDownLeft,
  FilePlus2,
  FolderOpen,
  MoreHorizontal,
  Play,
  Save,
  Square,
  Wand2,
} from "lucide-react";
import { format as formatSql } from "sql-formatter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  extractTemplateVars,
  renderSqlTemplate,
  type TemplateVarType,
  type TemplateVarValue,
} from "@/lib/query/sql-template";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizableSplit } from "@/components/layout/ResizableSplit";
import { SqlSidebar } from "./SqlSidebar";
import { SqlEditor } from "./SqlEditor";
import { SaveQueryDialog } from "./SaveQueryDialog";
import { ResultsRegion } from "@/components/results/ResultsRegion";
import { useEngine, useSources, useWorkspace } from "@/app/(app)/WorkspaceProvider";

export function SqlEditorView() {
  const router = useRouter();
  const engine = useEngine();
  const { sources, activeSource, activate } = useSources();
  const ws = useWorkspace();

  const [saveOpen, setSaveOpen] = React.useState(false);
  const [saveIntent, setSaveIntent] = React.useState<"save" | "saveAs">("save");
  const [limit, setLimit] = React.useState("100");
  const [exploring, setExploring] = React.useState(false);

  const openSaveDialog = (intent: "save" | "saveAs") => {
    setSaveIntent(intent);
    setSaveOpen(true);
  };

  // ── {{variable}} widgets — derived from the statement text itself ──────────
  const templateVars = React.useMemo(() => extractTemplateVars(ws.sql), [ws.sql]);
  const [varState, setVarState] = React.useState<Record<string, TemplateVarValue>>({});
  const [varError, setVarError] = React.useState<string | null>(null);
  const setVarValue = (name: string, value: string) =>
    setVarState((prev) => ({
      ...prev,
      [name]: { type: prev[name]?.type ?? "text", value },
    }));
  const setVarType = (name: string, type: TemplateVarType) =>
    setVarState((prev) => ({
      ...prev,
      [name]: { type, value: prev[name]?.value ?? "" },
    }));

  const canRun = ws.sql.trim() !== "" && !ws.running;
  /** Run the whole statement, or just the editor selection when given. */
  const run = React.useCallback(
    (selection?: string) => {
      const statement = selection ?? ws.sql;
      if (!statement.trim() || ws.running) return;
      let final = statement;
      if (extractTemplateVars(statement).length > 0) {
        const rendered = renderSqlTemplate(statement, varState);
        if (!rendered.ok) {
          setVarError(rendered.error);
          return;
        }
        final = rendered.sql;
      }
      setVarError(null);
      const maxRows = Number(limit);
      ws.runSql(final, maxRows > 0 ? { maxRows } : undefined);
    },
    [ws, limit, varState],
  );

  /** Pretty-print the statement; template markers are preserved as-is. */
  const formatStatement = () => {
    try {
      ws.setSql(
        formatSql(ws.sql, {
          language: "duckdb",
          keywordCase: "upper",
          paramTypes: {
            custom: [
              { regex: "\\{\\{[^{}]*\\}\\}" },
              { regex: "\\[\\[" },
              { regex: "\\]\\]" },
            ],
          },
        }),
      );
    } catch {
      // Unparseable text (mid-edit) — leave it untouched.
    }
  };

  const canExplore =
    ws.request?.kind === "sql" && !ws.request.datasetId && !ws.running && !exploring;
  const exploreResults = async () => {
    setExploring(true);
    try {
      await ws.exploreResults();
      router.push("/editor");
    } finally {
      setExploring(false);
    }
  };
  const dialogInitialName =
    saveIntent === "saveAs"
      ? ws.open
        ? `${ws.open.name} (copy)`
        : "SQL query"
      : ws.open?.name ?? "SQL query";

  return (
    <div className="flex h-full min-h-0">
      <SqlSidebar />

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
              <DropdownMenuItem
                onSelect={() => {
                  ws.newQuery();
                }}
              >
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
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="ml-2 hidden text-xs text-muted-foreground lg:inline">
            Autosave enabled
          </span>

          <div className="ml-auto flex items-center gap-2">
            <label className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
              Source
              <Select value={activeSource?.id ?? ""} onValueChange={(v) => void activate(v)}>
                <SelectTrigger className="h-8 w-[150px]">
                  <SelectValue placeholder="Select source" />
                </SelectTrigger>
                <SelectContent>
                  {sources.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <Select value={limit} onValueChange={setLimit}>
              <SelectTrigger className="hidden h-8 w-[130px] md:flex">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="100">Limit 100 rows</SelectItem>
                <SelectItem value="500">Limit 500 rows</SelectItem>
                <SelectItem value="1000">Limit 1000 rows</SelectItem>
                <SelectItem value="0">No limit</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title="Format SQL"
              aria-label="Format SQL"
              disabled={!ws.sql.trim()}
              onClick={formatStatement}
            >
              <Wand2 className="h-3.5 w-3.5" />
            </Button>
            {canExplore && (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                title="Open the visual builder over this result set"
                onClick={() => void exploreResults()}
              >
                <Compass className="h-3.5 w-3.5" />
                Explore results
              </Button>
            )}
            {ws.running ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => ws.cancel()}
              >
                <Square className="h-3 w-3 fill-current" />
                Cancel
              </Button>
            ) : (
              <Button size="sm" className="h-8" disabled={!canRun} onClick={() => run()}>
                <Play className="h-3.5 w-3.5" />
                Run
                <kbd className="ml-1 hidden items-center gap-0.5 rounded bg-primary-foreground/15 px-1 font-mono text-[10px] sm:inline-flex">
                  ⌘<CornerDownLeft className="h-2.5 w-2.5" />
                </kbd>
              </Button>
            )}
          </div>
        </div>

        {/* {{variable}} filter widgets — appear as soon as the statement uses them */}
        {templateVars.length > 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface-100 px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Variables
            </span>
            {templateVars.map((v) => {
              const cur = varState[v.name] ?? { type: "text" as const, value: "" };
              return (
                <div key={v.name} className="flex items-center gap-1.5">
                  <label
                    className="font-mono text-xs text-muted-foreground"
                    htmlFor={`var-${v.name}`}
                  >
                    {v.name}
                    {!v.required && (
                      <span className="ml-0.5 text-[10px] text-muted-foreground/70">
                        (optional)
                      </span>
                    )}
                  </label>
                  <Select
                    value={cur.type}
                    onValueChange={(t) => setVarType(v.name, t as TemplateVarType)}
                  >
                    <SelectTrigger className="h-8 w-[92px]" aria-label={`Type of ${v.name}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="number">Number</SelectItem>
                      <SelectItem value="date">Date</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    id={`var-${v.name}`}
                    type={cur.type === "date" ? "date" : "text"}
                    inputMode={cur.type === "number" ? "decimal" : undefined}
                    className="h-8 w-36"
                    value={cur.value}
                    placeholder={cur.type === "number" ? "0" : "value"}
                    onChange={(e) => setVarValue(v.name, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") run();
                    }}
                  />
                </div>
              );
            })}
            {varError && <span className="text-xs text-destructive">{varError}</span>}
          </div>
        )}

        {/* Editor / results split */}
        <div className="min-h-0 flex-1 p-3">
          <ResizableSplit
            orientation="vertical"
            className="h-full"
            defaultSize={55}
            first={
              <div className="h-full pb-3">
                <SqlEditor
                  value={ws.sql}
                  onChange={ws.setSql}
                  onRun={run}
                  schema={ws.fields}
                  tableName={ws.tableName}
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
                />
              </div>
            }
          />
        </div>
      </div>

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
