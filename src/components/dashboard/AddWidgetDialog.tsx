"use client";

/**
 * AddWidgetDialog — the add/edit-widget flow.
 *
 * Opens the advanced (IR) builder / SQL editor inside a Dialog. The user picks a
 * source + a visualization + a title, composes a query (Builder or raw SQL), and
 * on save we emit a `WidgetInput` the dashboard turns into a `Widget`. Reused for
 * EDIT too — `initial` prefills the controls and the footer commits an update.
 *
 * Reuse, not rebuild: `AdvancedQueryBuilder` + `SqlEditor` are the same
 * components the query panel uses. Nothing here runs a query — it only captures
 * the declarative definition. Switching Builder⇄SQL keeps each side's work (there
 * is no IR↔SQL translation). A legacy builder widget is migrated to IR on edit.
 */

import * as React from "react";
import { Code2, Layers } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type Field } from "@/lib/query/schema";
import {
  compileIrDraft,
  emptyIrDraft,
  irToDraft,
  type IrDraft,
} from "@/lib/query/ir-draft";
import { queryV1ToIR } from "@/lib/query/compile";
import type { QueryIR } from "@/lib/query/ir";
import type { Widget, WidgetViz, WidgetVizType } from "@/lib/types/dashboard";
import { AdvancedQueryBuilder } from "@/components/query/AdvancedQueryBuilder";
import { SqlEditor } from "@/components/query/SqlEditor";
import { VizFormatPanel } from "./VizFormatPanel";

/** What the dialog emits on save (the dashboard adds id + layout). */
export interface WidgetInput {
  title: string;
  sourceId: string;
  queryKind: "ir" | "sql";
  ir?: QueryIR;
  sql?: string;
  viz: WidgetViz;
}

interface SourceOption {
  id: string;
  name: string;
}

interface AddWidgetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: SourceOption[];
  getFields: (sourceId: string) => Promise<Field[]>;
  tableNameForId: (sourceId: string) => string;
  /** When set, the dialog edits this widget instead of creating a new one. */
  initial?: Widget | null;
  onSubmit: (input: WidgetInput, editingId: string | null) => void;
}

const VIZ_OPTIONS: { value: WidgetVizType; label: string }[] = [
  { value: "bar", label: "Bar chart" },
  { value: "line", label: "Line chart" },
  { value: "area", label: "Area chart" },
  { value: "combo", label: "Combo (bar + line)" },
  { value: "pie", label: "Pie / donut" },
  { value: "scatter", label: "Scatter / bubble" },
  { value: "pivot", label: "Pivot table" },
  { value: "gauge", label: "Gauge" },
  { value: "funnel", label: "Funnel" },
  { value: "waterfall", label: "Waterfall" },
  { value: "map", label: "Geo map" },
  { value: "table", label: "Table" },
  { value: "kpi", label: "KPI" },
];

type Mode = "ir" | "sql";

/** Derive the IR to seed the builder from an existing widget (any kind). */
function widgetToIr(widget: Widget): QueryIR | undefined {
  if (widget.queryKind === "ir") return widget.ir;
  if (widget.queryKind === "builder" && widget.query) return queryV1ToIR(widget.query);
  return undefined;
}

export function AddWidgetDialog({
  open,
  onOpenChange,
  sources,
  getFields,
  tableNameForId,
  initial,
  onSubmit,
}: AddWidgetDialogProps) {
  const editing = initial ?? null;

  const [sourceId, setSourceId] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [viz, setViz] = React.useState<WidgetViz>({ type: "bar" });
  const [mode, setMode] = React.useState<Mode>("ir");
  const [fields, setFields] = React.useState<Field[]>([]);
  const [draft, setDraft] = React.useState<IrDraft>(() => emptyIrDraft([]));
  const [sql, setSql] = React.useState("");

  // Seed the form whenever the dialog opens (new or edit).
  React.useEffect(() => {
    if (!open) return;
    if (editing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds editable form fields from props when the dialog opens
      setSourceId(editing.sourceId);
      setTitle(editing.title);
      setViz(editing.viz);
      setMode(editing.queryKind === "sql" ? "sql" : "ir");
      setSql(editing.sql ?? "");
      const ir = widgetToIr(editing);
      setDraft(ir ? irToDraft(ir) : emptyIrDraft([]));
    } else {
      setSourceId(sources[0]?.id ?? "");
      setTitle("");
      setViz({ type: "bar" });
      setMode("ir");
      setSql("");
      setDraft(emptyIrDraft([]));
    }
    // Only re-seed on open / target change, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  // Load the chosen source's schema; fill defaults into a blank NEW draft.
  React.useEffect(() => {
    if (!open || !sourceId) return;
    let cancelled = false;
    void getFields(sourceId).then((f) => {
      if (cancelled) return;
      setFields(f);
      if (!editing) {
        setDraft((prev) =>
          prev.dimensions.length === 0 && prev.filters.length === 0 ? emptyIrDraft(f) : prev,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, sourceId, getFields, editing]);

  const compiled = React.useMemo(
    () => compileIrDraft(draft, fields, sourceId ? tableNameForId(sourceId) : "dataset"),
    [draft, fields, sourceId, tableNameForId],
  );

  const canSubmit =
    !!sourceId && (mode === "ir" ? !!compiled.ir : sql.trim().length > 0);

  const submit = () => {
    if (!canSubmit) return;
    const resolvedTitle = title.trim() || (mode === "ir" ? "Advanced widget" : "SQL widget");
    const input: WidgetInput =
      mode === "ir"
        ? { title: resolvedTitle, sourceId, queryKind: "ir", ir: compiled.ir!, viz }
        : { title: resolvedTitle, sourceId, queryKind: "sql", sql, viz };
    onSubmit(input, editing?.id ?? null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-full max-w-3xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit widget" : "Add widget"}</DialogTitle>
        </DialogHeader>

        {/* ── Meta row: source · title · viz ─────────────────────────── */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Source</span>
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger aria-label="Source">
                <SelectValue placeholder="Pick a source" />
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

          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Title</span>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Widget title"
            />
          </label>

          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              Visualization
            </span>
            <Select
              value={viz.type}
              onValueChange={(v) => setViz((cur) => ({ ...cur, type: v as WidgetVizType }))}
            >
              <SelectTrigger aria-label="Visualization">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VIZ_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>

        {/* ── Builder/SQL toggle ─────────────────────────────────────── */}
        <div className="inline-flex w-fit rounded-md border border-border bg-muted p-0.5">
          <Button
            type="button"
            size="sm"
            variant={mode === "ir" ? "secondary" : "ghost"}
            className="h-7 gap-1.5"
            onClick={() => setMode("ir")}
          >
            <Layers className="h-3.5 w-3.5" />
            Builder
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "sql" ? "secondary" : "ghost"}
            className="h-7 gap-1.5"
            onClick={() => setMode("sql")}
          >
            <Code2 className="h-3.5 w-3.5" />
            SQL
          </Button>
        </div>

        {/* ── Editor body ────────────────────────────────────────────── */}
        <div className="min-h-[280px] flex-1 space-y-4 overflow-auto">
          {mode === "ir" ? (
            <AdvancedQueryBuilder
              fields={fields}
              datasetName={sources.find((s) => s.id === sourceId)?.name ?? "Source"}
              draft={draft}
              onDraftChange={setDraft}
              compiled={compiled}
            />
          ) : (
            <SqlEditor
              value={sql}
              onChange={setSql}
              schema={fields}
              tableName={sourceId ? tableNameForId(sourceId) : "dataset"}
            />
          )}

          {/* ── Format & style ─────────────────────────────────────────── */}
          <div className="rounded-lg border border-border p-3">
            <p className="mb-3 text-sm font-medium">Format &amp; style</p>
            <VizFormatPanel viz={viz} fields={fields} onChange={(p) => setViz((cur) => ({ ...cur, ...p }))} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {editing ? "Save changes" : "Add widget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
