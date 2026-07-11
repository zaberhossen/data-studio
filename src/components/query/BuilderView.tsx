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
import { FilePlus2, FolderOpen, MoreHorizontal, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizableSplit } from "@/components/layout/ResizableSplit";
import { SchemaTree } from "./SchemaTree";
import { AdvancedQueryBuilder } from "./AdvancedQueryBuilder";
import { SaveQueryDialog } from "./SaveQueryDialog";
import { ResultsRegion } from "@/components/results/ResultsRegion";
import { useEngine, useWorkspace } from "@/app/(app)/WorkspaceProvider";

export function BuilderView() {
  const router = useRouter();
  const engine = useEngine();
  const ws = useWorkspace();

  const [saveOpen, setSaveOpen] = React.useState(false);
  const [saveIntent, setSaveIntent] = React.useState<"save" | "saveAs">("save");

  const openSaveDialog = (intent: "save" | "saveAs") => {
    setSaveIntent(intent);
    setSaveOpen(true);
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
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="ml-auto text-xs text-muted-foreground">Visual query builder</span>
        </div>

        {/* Builder / results split */}
        <div className="min-h-0 flex-1 p-3">
          <ResizableSplit
            orientation="horizontal"
            className="h-full"
            defaultSize={42}
            first={
              <div className="h-full overflow-auto pr-3">
                <AdvancedQueryBuilder
                  fields={ws.fields}
                  datasetName={ws.datasetName}
                  draft={ws.irDraft}
                  onDraftChange={ws.setIrDraft}
                  compiled={ws.compiledIr}
                  onRun={ws.runIr}
                  running={ws.running}
                  execution={{
                    value: ws.executionMode,
                    onChange: ws.setExecutionMode,
                    resolved: ws.resolvedExecution,
                    canPushdown: ws.canPushdown,
                  }}
                />
              </div>
            }
            second={
              <div className="h-full pl-3">
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
