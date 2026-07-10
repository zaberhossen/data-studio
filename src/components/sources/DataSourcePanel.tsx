"use client";

/**
 * DataSourcePanel — the data-source sidebar: list every source with a status
 * badge + row count, highlight the active one, and expose per-source actions
 * (set active, test, refresh, remove). The "Add source" button opens the
 * AddSourceDialog.
 *
 * METADATA ONLY: this panel never renders or holds raw rows. Activating a
 * source delegates to the engine (via the parent's `api`); the panel only
 * reflects the resulting status (connecting → ready · N rows → error).
 *
 * States designed: empty (no user sources), idle, connecting, file-parsing,
 * ready, error, list-loading, list-error.
 */

import * as React from "react";
import {
  AlertCircle,
  Database,
  FileSpreadsheet,
  Globe,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { DataSourceKind } from "@/lib/types/datasource";
import {
  DEMO_SOURCE_ID,
  type DataSourcesApi,
  type SourceView,
} from "@/hooks/useDataSources";
import { AddSourceDialog } from "./AddSourceDialog";

const KIND_ICON: Record<DataSourceKind, React.ComponentType<{ className?: string }>> = {
  file: FileSpreadsheet,
  postgres: Database,
  mysql: Database,
  "http-file": Globe,
  "rest-api": Globe,
};

/** Kinds that connect over the network and therefore support a test. */
const TESTABLE = new Set<DataSourceKind>(["postgres", "mysql", "http-file", "rest-api"]);

export function DataSourcePanel({ api }: { api: DataSourcesApi }) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [rotating, setRotating] = React.useState<{ id: string; kind: DataSourceKind; name: string } | null>(null);
  const { sources, activeId } = api;
  const userSourceCount = sources.filter((s) => !s.builtin).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border p-3">
        <div>
          <h2 className="text-sm font-semibold">Data sources</h2>
          <p className="text-xs text-muted-foreground">
            {api.listLoading ? "Loading…" : `${sources.length} connected`}
          </p>
        </div>
        <Button size="sm" onClick={() => { setRotating(null); setDialogOpen(true); }}>
          <Plus className="h-3.5 w-3.5" />
          Add source
        </Button>
      </div>

      {api.listError && (
        <p className="m-3 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
          {api.listError}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <ul className="space-y-1.5">
          {sources.map((source) => (
            <SourceItem
              key={source.id}
              source={source}
              active={source.id === activeId}
              onActivate={() => void api.activate(source.id)}
              onTest={() => void api.testSource(source.id)}
              onRefresh={() => void api.activate(source.id)}
              onRotate={() => {
                setRotating({ id: source.id, kind: source.kind, name: source.name });
                setDialogOpen(true);
              }}
              onRemove={() => {
                if (
                  window.confirm(`Remove “${source.name}”? This can’t be undone.`)
                ) {
                  void api.removeSource(source.id);
                }
              }}
            />
          ))}
        </ul>

        {userSourceCount === 0 && (
          <div className="mt-3 rounded-lg border border-dashed border-border p-4 text-center">
            <p className="text-xs font-medium">No sources yet</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Try the built-in demo above, or connect a database / upload a file.
            </p>
          </div>
        )}
      </div>

      <AddSourceDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) setRotating(null);
        }}
        onAddServer={api.addServerSource}
        onAddFile={api.addFileSource}
        rotating={rotating}
        onRotate={api.rotateSource}
      />
    </div>
  );
}

function SourceItem({
  source,
  active,
  onActivate,
  onTest,
  onRefresh,
  onRotate,
  onRemove,
}: {
  source: SourceView;
  active: boolean;
  onActivate: () => void;
  onTest: () => void;
  onRefresh: () => void;
  onRotate: () => void;
  onRemove: () => void;
}) {
  const Icon = source.builtin ? Sparkles : KIND_ICON[source.kind];
  const connecting = source.status === "connecting";

  return (
    <li
      className={cn(
        "group rounded-lg border p-2.5 transition-colors",
        active
          ? "border-primary/60 bg-primary/5"
          : "border-border hover:bg-accent",
      )}
    >
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          onClick={onActivate}
          aria-current={active ? "true" : undefined}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
        >
          <span
            className={cn(
              "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
              active
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{source.name}</span>
              {active && (
                <Badge variant="secondary" className="shrink-0">
                  active
                </Badge>
              )}
            </span>
            <SourceStatus source={source} />
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          {TESTABLE.has(source.kind) && !source.builtin && (
            <IconAction label="Test connection" onClick={onTest} disabled={connecting}>
              <Plug className="h-3.5 w-3.5" />
            </IconAction>
          )}
          <IconAction label="Reload" onClick={onRefresh} disabled={connecting}>
            <RefreshCw className={cn("h-3.5 w-3.5", connecting && "animate-spin")} />
          </IconAction>
          {TESTABLE.has(source.kind) && !source.builtin && (
            <IconAction label="Rotate credentials" onClick={onRotate} disabled={connecting}>
              <KeyRound className="h-3.5 w-3.5" />
            </IconAction>
          )}
          {!source.builtin && (
            <IconAction label="Remove" onClick={onRemove} disabled={connecting}>
              <Trash2 className="h-3.5 w-3.5" />
            </IconAction>
          )}
        </div>
      </div>
    </li>
  );
}

function SourceStatus({ source }: { source: SourceView }) {
  switch (source.status) {
    case "connecting":
      return (
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {source.kind === "file" || source.builtin ? "Parsing…" : "Connecting…"}
        </span>
      );
    case "ready":
      return (
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          {typeof source.rowCount === "number"
            ? `Ready · ${source.rowCount.toLocaleString()} rows`
            : "Ready"}
        </span>
      );
    case "error":
      return (
        <span
          className="mt-0.5 flex items-center gap-1.5 text-xs text-destructive"
          title={source.error}
        >
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="truncate">{source.error ?? "Error"}</span>
        </span>
      );
    case "idle":
    default:
      return (
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {source.id === DEMO_SOURCE_ID
            ? "Built-in sample dataset"
            : "Not loaded — click to activate"}
        </span>
      );
  }
}

function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-foreground"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </Button>
  );
}
