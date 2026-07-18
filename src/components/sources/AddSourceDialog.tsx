"use client";

/**
 * AddSourceDialog — kind selector → conditional connection form.
 *
 *   File              → drag-drop zone; parsed client-side, never hits the server.
 *   Postgres / MySQL  → host/port/database/user/password/table → POST (server-side).
 *   HTTP file         → URL.
 *   REST API          → URL + optional auth token (stored server-side).
 *
 * The password/token are typed here and submitted ONCE; the server stores them
 * and never echoes them back, so this component is the only place they live in
 * the browser — transiently, in a controlled input.
 *
 * shadcn primitives: Dialog, Select, Input, Button, Badge.
 * States: per-kind form, file drag-active, submitting, error.
 */

import * as React from "react";
import { Loader2, UploadCloud } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type {
  CreateDataSourceInput,
  DataSourceKind,
} from "@/lib/types/datasource";

interface AddSourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Create a server-side source (Postgres/MySQL/HTTP/REST). */
  onAddServer: (input: CreateDataSourceInput) => Promise<unknown>;
  /** Add a client-side file source (CSV/Parquet/JSON). */
  onAddFile: (file: File) => Promise<void>;
  /**
   * When set, the dialog ROTATES this source's credentials instead of creating:
   * the kind is fixed, name preset, and submit calls `onRotate`.
   */
  rotating?: { id: string; kind: DataSourceKind; name: string } | null;
  onRotate?: (id: string, input: CreateDataSourceInput) => Promise<unknown>;
}

const KIND_LABELS: Record<DataSourceKind, string> = {
  file: "File upload (CSV / Parquet / JSON)",
  postgres: "PostgreSQL",
  mysql: "MySQL",
  "http-file": "HTTP file (URL)",
  "rest-api": "REST API",
};

interface FormState {
  name: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  table: string;
  ssl: boolean;
  url: string;
  authToken: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  host: "localhost",
  port: "5432",
  database: "",
  user: "",
  password: "",
  table: "",
  ssl: false,
  url: "",
  authToken: "",
};

export function AddSourceDialog({
  open,
  onOpenChange,
  onAddServer,
  onAddFile,
  rotating = null,
  onRotate,
}: AddSourceDialogProps) {
  const [kind, setKind] = React.useState<DataSourceKind>("file");
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [dragActive, setDragActive] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Reset everything whenever the dialog opens fresh — or seed rotate mode.
  React.useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset/seed the dialog's editable form state each time it opens
    setError(null);
    setSubmitting(false);
    setDragActive(false);
    if (rotating) {
      setKind(rotating.kind);
      setForm({ ...EMPTY_FORM, name: rotating.name });
    } else {
      setKind("file");
      setForm(EMPTY_FORM);
    }
  }, [open, rotating]);

  const patch = (next: Partial<FormState>) => setForm((f) => ({ ...f, ...next }));

  const handleFile = async (file: File) => {
    setError(null);
    setSubmitting(true);
    try {
      await onAddFile(file);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the file.");
      setSubmitting(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const submitServer = async () => {
    setError(null);
    const input = buildInput(kind, form);
    if ("error" in input) {
      setError(input.error);
      return;
    }
    setSubmitting(true);
    try {
      if (rotating && onRotate) await onRotate(rotating.id, input.value);
      else await onAddServer(input.value);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save source.");
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rotating ? "Rotate credentials" : "Add data source"}</DialogTitle>
          <DialogDescription>
            {rotating
              ? `Enter new connection details for “${rotating.name}”. The previous secret is replaced.`
              : "Connect a database or API, or upload a file to analyze in the browser."}
          </DialogDescription>
        </DialogHeader>

        {/* Kind selector (locked when rotating — the kind can't change) */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Source type
          </label>
          <Select value={kind} onValueChange={(v) => setKind(v as DataSourceKind)} disabled={!!rotating}>
            <SelectTrigger aria-label="Source type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(KIND_LABELS) as DataSourceKind[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Conditional body */}
        {kind === "file" ? (
          <FileDropZone
            dragActive={dragActive}
            submitting={submitting}
            onPickClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={onDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.tsv,.parquet,.pq,.json,.ndjson"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
          </FileDropZone>
        ) : (
          <div className="space-y-3">
            <FormField label="Source name">
              <Input
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="e.g. Production analytics"
              />
            </FormField>

            {(kind === "postgres" || kind === "mysql") && (
              <>
                <div className="grid grid-cols-[1fr_96px] gap-2">
                  <FormField label="Host">
                    <Input
                      value={form.host}
                      onChange={(e) => patch({ host: e.target.value })}
                    />
                  </FormField>
                  <FormField label="Port">
                    <Input
                      type="number"
                      value={form.port}
                      onChange={(e) => patch({ port: e.target.value })}
                    />
                  </FormField>
                </div>
                <FormField label="Database">
                  <Input
                    value={form.database}
                    onChange={(e) => patch({ database: e.target.value })}
                  />
                </FormField>
                <div className="grid grid-cols-2 gap-2">
                  <FormField label="User">
                    <Input
                      value={form.user}
                      onChange={(e) => patch({ user: e.target.value })}
                    />
                  </FormField>
                  <FormField label="Password">
                    <Input
                      type="password"
                      value={form.password}
                      onChange={(e) => patch({ password: e.target.value })}
                      autoComplete="off"
                    />
                  </FormField>
                </div>
                <FormField label="Table / view (optional)">
                  <Input
                    value={form.table}
                    onChange={(e) => patch({ table: e.target.value })}
                    placeholder="public.orders"
                  />
                </FormField>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.ssl}
                    onChange={(e) => patch({ ssl: e.target.checked })}
                    className="h-4 w-4 rounded border-input"
                  />
                  Require SSL
                </label>
              </>
            )}

            {kind === "http-file" && (
              <FormField label="File URL">
                <Input
                  value={form.url}
                  onChange={(e) => patch({ url: e.target.value })}
                  placeholder="https://example.com/data.csv"
                />
              </FormField>
            )}

            {kind === "rest-api" && (
              <>
                <FormField label="Endpoint URL">
                  <Input
                    value={form.url}
                    onChange={(e) => patch({ url: e.target.value })}
                    placeholder="https://api.example.com/v1/records"
                  />
                </FormField>
                <FormField label="Auth token (optional)">
                  <Input
                    type="password"
                    value={form.authToken}
                    onChange={(e) => patch({ authToken: e.target.value })}
                    autoComplete="off"
                  />
                </FormField>
              </>
            )}
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive"
          >
            {error}
          </p>
        )}

        {kind !== "file" && (
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button onClick={submitServer} disabled={submitting}>
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save source
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function FileDropZone({
  dragActive,
  submitting,
  onPickClick,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
}: {
  dragActive: boolean;
  submitting: boolean;
  onPickClick: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onPickClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      disabled={submitting}
      className={
        "flex w-full flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-8 text-center transition-colors " +
        (dragActive
          ? "border-primary bg-primary/5"
          : "border-border hover:border-primary/50 hover:bg-accent")
      }
    >
      {submitting ? (
        <>
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Parsing file…</span>
        </>
      ) : (
        <>
          <UploadCloud className="h-6 w-6 text-muted-foreground" />
          <span className="text-sm font-medium">
            Drop a file here, or click to browse
          </span>
          <span className="text-xs text-muted-foreground">
            CSV, Parquet, or JSON — parsed in your browser, never uploaded.
          </span>
        </>
      )}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Build + validate the create payload from form state.
// ---------------------------------------------------------------------------

type BuildResult =
  | { value: CreateDataSourceInput }
  | { error: string };

function buildInput(kind: DataSourceKind, form: FormState): BuildResult {
  const name = form.name.trim();
  if (!name) return { error: "A source name is required." };

  switch (kind) {
    case "postgres":
    case "mysql": {
      const port = Number(form.port);
      if (!form.host.trim()) return { error: "Host is required." };
      if (!form.database.trim()) return { error: "Database is required." };
      if (!form.user.trim()) return { error: "User is required." };
      if (!Number.isFinite(port) || port <= 0) {
        return { error: "Enter a valid port." };
      }
      return {
        value: {
          kind,
          name,
          host: form.host.trim(),
          port,
          database: form.database.trim(),
          user: form.user.trim(),
          password: form.password,
          table: form.table.trim() || undefined,
          ssl: form.ssl,
        },
      };
    }
    case "http-file": {
      if (!form.url.trim()) return { error: "A file URL is required." };
      return { value: { kind, name, url: form.url.trim() } };
    }
    case "rest-api": {
      if (!form.url.trim()) return { error: "An endpoint URL is required." };
      return {
        value: {
          kind,
          name,
          url: form.url.trim(),
          authToken: form.authToken.trim() || undefined,
        },
      };
    }
    default:
      return { error: "Unsupported source type." };
  }
}
