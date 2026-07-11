"use client";

/**
 * DataSourcesView — the /sources page: a two-column browser (Supabase style).
 * Left: the source list. Right: the selected source's schema table (columns +
 * type + role/label curation), folding in what used to be the standalone Fields
 * panel.
 *
 * SELECTION = the ACTIVE source: picking a row activates it (loads it into the
 * engine, exactly as before), so `activeFields`/`fieldOverrides` reflect the
 * selection and the role/label overrides persist per source. METADATA ONLY —
 * this view never holds raw rows.
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
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { DataSourceKind } from "@/lib/types/datasource";
import type { Field, FieldRole } from "@/lib/query/schema";
import { DEMO_SOURCE_ID, type SourceView } from "@/hooks/useDataSources";
import { useSources } from "@/app/(app)/WorkspaceProvider";
import { AddSourceDialog } from "./AddSourceDialog";

const KIND_ICON: Record<DataSourceKind, React.ComponentType<{ className?: string }>> = {
  file: FileSpreadsheet,
  postgres: Database,
  mysql: Database,
  "http-file": Globe,
  "rest-api": Globe,
};

const TESTABLE = new Set<DataSourceKind>(["postgres", "mysql", "http-file", "rest-api"]);
const ROLE_LABEL: Record<FieldRole, string> = { dimension: "Dimension", metric: "Metric" };

export function DataSourcesView() {
  const api = useSources();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [rotating, setRotating] = React.useState<{
    id: string;
    kind: DataSourceKind;
    name: string;
  } | null>(null);

  const selected = api.activeSource;

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left: source list ─────────────────────────────────────────── */}
      <div className="flex h-full w-72 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
          <div>
            <h2 className="text-sm font-semibold">Data sources</h2>
            <p className="text-xs text-muted-foreground">
              {api.listLoading ? "Loading…" : `${api.sources.length} connected`}
            </p>
          </div>
          <Button
            size="xs"
            onClick={() => {
              setRotating(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>

        {api.listError && (
          <p className="m-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            {api.listError}
          </p>
        )}

        <ul className="min-h-0 flex-1 overflow-auto p-1.5">
          {api.sources.map((s) => {
            const Icon = s.builtin ? Sparkles : KIND_ICON[s.kind];
            const isSelected = s.id === selected?.id;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => void api.activate(s.id)}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-md p-2 text-left transition-colors",
                    isSelected ? "bg-secondary" : "hover:bg-accent",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                      isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{s.name}</span>
                    <SourceStatus source={s} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ── Right: schema / detail ────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <Centered>
            <p className="text-sm font-medium">Select a data source</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Pick a source on the left to view and curate its schema.
            </p>
          </Centered>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">{selected.name}</span>
                  <Badge variant="muted" className="capitalize">
                    {selected.builtin ? "demo" : selected.kind}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {api.activeFields.length}{" "}
                  {api.activeFields.length === 1 ? "field" : "fields"}
                  {typeof selected.rowCount === "number"
                    ? ` · ${selected.rowCount.toLocaleString()} rows`
                    : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {TESTABLE.has(selected.kind) && !selected.builtin && (
                  <IconAction label="Test connection" onClick={() => void api.testSource(selected.id)}>
                    <Plug className="h-3.5 w-3.5" />
                  </IconAction>
                )}
                <IconAction label="Reload" onClick={() => void api.activate(selected.id)}>
                  <RefreshCw
                    className={cn(
                      "h-3.5 w-3.5",
                      selected.status === "connecting" && "animate-spin",
                    )}
                  />
                </IconAction>
                {TESTABLE.has(selected.kind) && !selected.builtin && (
                  <IconAction
                    label="Rotate credentials"
                    onClick={() => {
                      setRotating({ id: selected.id, kind: selected.kind, name: selected.name });
                      setDialogOpen(true);
                    }}
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                  </IconAction>
                )}
                {!selected.builtin && (
                  <IconAction
                    label="Remove"
                    destructive
                    onClick={() => {
                      if (window.confirm(`Remove “${selected.name}”? This can't be undone.`)) {
                        void api.removeSource(selected.id);
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconAction>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-4">
              {selected.status === "connecting" ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading schema…
                </div>
              ) : selected.status === "error" ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  {selected.error ?? "Failed to load this source."}
                </p>
              ) : api.activeFields.length === 0 ? (
                <p className="text-sm text-muted-foreground">No fields available for this source.</p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Column</th>
                        <th className="px-3 py-2 text-left font-medium">Type</th>
                        <th className="px-3 py-2 text-left font-medium">Role</th>
                        <th className="px-3 py-2 text-left font-medium">Label</th>
                        <th className="w-10 px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {api.activeFields.map((f) => (
                        <FieldRow
                          key={f.name}
                          field={f}
                          overridden={!!api.fieldOverrides[f.name]}
                          onRoleChange={(role) =>
                            void api.setFieldOverride(selected.id, f.name, { role })
                          }
                          onLabelCommit={(label) =>
                            void api.setFieldOverride(selected.id, f.name, { label })
                          }
                          onReset={() => void api.resetFieldOverride(selected.id, f.name)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
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
            ? `${source.rowCount.toLocaleString()} rows`
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
    default:
      return (
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {source.id === DEMO_SOURCE_ID ? "Built-in sample dataset" : "Not loaded"}
        </span>
      );
  }
}

function FieldRow({
  field,
  overridden,
  onRoleChange,
  onLabelCommit,
  onReset,
}: {
  field: Field;
  overridden: boolean;
  onRoleChange: (role: FieldRole) => void;
  onLabelCommit: (label: string) => void;
  onReset: () => void;
}) {
  const [label, setLabel] = React.useState(field.label);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- sync the editable label input when the underlying field prop changes
  React.useEffect(() => setLabel(field.label), [field.label]);

  return (
    <tr>
      <td className="px-3 py-2 font-mono text-xs">{field.name}</td>
      <td className="px-3 py-2">
        <Badge variant="muted">{field.dataType}</Badge>
      </td>
      <td className="px-3 py-2">
        <Select value={field.role} onValueChange={(v) => onRoleChange(v as FieldRole)}>
          <SelectTrigger className="h-8 w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dimension">{ROLE_LABEL.dimension}</SelectItem>
            <SelectItem value="metric">{ROLE_LABEL.metric}</SelectItem>
          </SelectContent>
        </Select>
      </td>
      <td className="px-3 py-2">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => {
            if (label.trim() && label !== field.label) onLabelCommit(label);
          }}
          className="h-8 max-w-[220px]"
          aria-label={`Label for ${field.name}`}
        />
      </td>
      <td className="px-3 py-2">
        {overridden && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Reset to default"
            onClick={onReset}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        )}
      </td>
    </tr>
  );
}

function IconAction({
  label,
  onClick,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("h-8 w-8 text-muted-foreground hover:text-foreground", destructive && "hover:text-destructive")}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm text-center">{children}</div>
    </div>
  );
}
