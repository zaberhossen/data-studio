"use client";

/**
 * SqlEditorView — the /sql page surface (Supabase SQL editor style):
 *   SqlSidebar | (toolbar → CodeMirror  /  Results·Chart split)
 *
 * Repackages the raw-SQL half of the old QueryPanel into a full page. The toolbar
 * carries an autosave hint, a ⋯ actions menu (New / Open / Save / Save as), a
 * functional Source picker, a display-only Limit select, and a green Run button.
 * Editor + results are a vertical ResizableSplit; both are controlled by the
 * hoisted workspace so state persists across navigation.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, FilePlus2, FolderOpen, MoreHorizontal, Play, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

  const openSaveDialog = (intent: "save" | "saveAs") => {
    setSaveIntent(intent);
    setSaveOpen(true);
  };

  const canRun = ws.sql.trim() !== "" && !ws.running;
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
            <Button size="sm" className="h-8" disabled={!canRun} onClick={() => ws.runSql(ws.sql)}>
              <Play className="h-3.5 w-3.5" />
              Run
              <kbd className="ml-1 hidden items-center gap-0.5 rounded bg-primary-foreground/15 px-1 font-mono text-[10px] sm:inline-flex">
                ⌘<CornerDownLeft className="h-2.5 w-2.5" />
              </kbd>
            </Button>
          </div>
        </div>

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
