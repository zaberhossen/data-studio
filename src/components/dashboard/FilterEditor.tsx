"use client";

/**
 * FilterEditor — add / edit / remove filter definitions in dashboard edit mode.
 *
 * Each filter definition specifies:
 *   - label: display name in the filter bar
 *   - kind: control type (date-range, select, multi-select, number-range, text)
 *   - targets: per-widget column mappings (widgetId + column name)
 *   - op: optional operator override
 *
 * This component renders as a compact inline section under the filter bar in
 * edit mode. Filter definitions are persisted in Dashboard.filters.
 */

import * as React from "react";
import { Plus, Settings2, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  DashboardFilter,
  FilterKind,
  FilterOperator,
  FilterTarget,
  Widget,
} from "@/lib/types/dashboard";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FilterEditorProps {
  filters: DashboardFilter[];
  widgets: Widget[];
  onAdd: (filter: Omit<DashboardFilter, "id">) => void;
  onUpdate: (id: string, patch: Partial<DashboardFilter>) => void;
  onRemove: (id: string) => void;
}

// ── Main editor strip (shown in edit mode below the filter bar) ───────────────

export function FilterEditor({
  filters,
  widgets,
  onAdd,
  onUpdate,
  onRemove,
}: FilterEditorProps) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<DashboardFilter | null>(null);

  const openAdd = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (f: DashboardFilter) => {
    setEditing(f);
    setDialogOpen(true);
  };

  const handleSubmit = (draft: FilterDraft) => {
    if (editing) {
      onUpdate(editing.id, {
        label: draft.label,
        kind: draft.kind,
        targets: draft.targets,
        op: draft.op || undefined,
      });
    } else {
      onAdd({
        label: draft.label,
        kind: draft.kind,
        targets: draft.targets,
        op: draft.op || undefined,
      });
    }
    setDialogOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/10 px-4 py-1.5">
      <span className="text-xs font-medium text-muted-foreground">
        Filter definitions:
      </span>

      {filters.map((f) => (
        <FilterPill
          key={f.id}
          filter={f}
          onEdit={() => openEdit(f)}
          onRemove={() => onRemove(f.id)}
        />
      ))}

      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 text-xs"
        onClick={openAdd}
      >
        <Plus className="h-3.5 w-3.5" />
        Add filter
      </Button>

      <FilterDefinitionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editing}
        widgets={widgets}
        onSubmit={handleSubmit}
      />
    </div>
  );
}

// ── Small pill showing an existing filter definition ──────────────────────────

function FilterPill({
  filter,
  onEdit,
  onRemove,
}: {
  filter: DashboardFilter;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <span className="flex items-center gap-1 rounded border border-border bg-background px-2 py-0.5 text-xs">
      <span className="font-medium">{filter.label}</span>
      <span className="text-muted-foreground">({filter.kind})</span>
      <span className="text-muted-foreground">
        → {filter.targets.length} widget{filter.targets.length !== 1 ? "s" : ""}
      </span>
      <button
        type="button"
        onClick={onEdit}
        className="ml-0.5 text-muted-foreground hover:text-foreground"
        aria-label={`Edit ${filter.label} filter`}
      >
        <Settings2 className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="text-muted-foreground hover:text-destructive"
        aria-label={`Remove ${filter.label} filter`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

// ── Add / Edit dialog ─────────────────────────────────────────────────────────

interface FilterDraft {
  label: string;
  kind: FilterKind;
  targets: FilterTarget[];
  op: FilterOperator | "";
}

const KINDS: FilterKind[] = [
  "select",
  "multi-select",
  "text",
  "date-range",
  "number-range",
];

const OPERATORS: Array<{ value: FilterOperator | ""; label: string }> = [
  { value: "", label: "Default for kind" },
  { value: "eq", label: "= (equals)" },
  { value: "neq", label: "≠ (not equals)" },
  { value: "gt", label: "> (greater than)" },
  { value: "gte", label: "≥ (greater than or equal)" },
  { value: "lt", label: "< (less than)" },
  { value: "lte", label: "≤ (less than or equal)" },
  { value: "contains", label: "contains" },
  { value: "in_list", label: "in list" },
];

interface FilterDefinitionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: DashboardFilter | null;
  widgets: Widget[];
  onSubmit: (draft: FilterDraft) => void;
}

function FilterDefinitionDialog({
  open,
  onOpenChange,
  initial,
  widgets,
  onSubmit,
}: FilterDefinitionDialogProps) {
  const [label, setLabel] = React.useState("");
  const [kind, setKind] = React.useState<FilterKind>("select");
  const [targets, setTargets] = React.useState<FilterTarget[]>([]);
  const [op, setOp] = React.useState<FilterOperator | "">("");

  React.useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds editable form fields from props when the dialog opens
      setLabel(initial?.label ?? "");
      setKind(initial?.kind ?? "select");
      setTargets(initial?.targets ?? []);
      setOp(initial?.op ?? "");
    }
  }, [open, initial]);

  const addTarget = () => {
    if (widgets.length === 0) return;
    const firstUnused = widgets.find(
      (w) => !targets.some((t) => t.widgetId === w.id),
    );
    const widgetId = firstUnused?.id ?? widgets[0].id;
    setTargets((prev) => [...prev, { widgetId, column: "" }]);
  };

  const updateTarget = (idx: number, patch: Partial<FilterTarget>) => {
    setTargets((prev) =>
      prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)),
    );
  };

  const removeTarget = (idx: number) => {
    setTargets((prev) => prev.filter((_, i) => i !== idx));
  };

  const canSubmit = label.trim().length > 0 && targets.length > 0 &&
    targets.every((t) => t.widgetId && t.column.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {initial ? "Edit filter" : "Add filter"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Label */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Label</label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Region, Date range"
              autoFocus
            />
          </div>

          {/* Kind */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Control type</label>
            <div className="flex flex-wrap gap-1.5">
              {KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                    kind === k
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>

          {/* Operator override */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Operator</label>
            <select
              value={op}
              onChange={(e) => setOp(e.target.value as FilterOperator | "")}
              className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            >
              {OPERATORS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {/* Widget targets */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Widget targets</label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={addTarget}
                disabled={widgets.length === 0}
              >
                <Plus className="h-3.5 w-3.5" />
                Add widget
              </Button>
            </div>

            {targets.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Add at least one widget mapping to activate this filter.
              </p>
            )}

            {targets.map((t, idx) => (
              <div key={idx} className="flex items-center gap-2">
                {/* Widget picker */}
                <select
                  value={t.widgetId}
                  onChange={(e) => updateTarget(idx, { widgetId: e.target.value })}
                  className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs"
                  aria-label="Widget"
                >
                  {widgets.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.title}
                    </option>
                  ))}
                </select>

                {/* Column name */}
                <Input
                  value={t.column}
                  onChange={(e) => updateTarget(idx, { column: e.target.value })}
                  placeholder="column name"
                  className="h-8 flex-1 text-xs"
                  aria-label="Column name"
                />

                <button
                  type="button"
                  onClick={() => removeTarget(idx)}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:border-destructive/50 hover:text-destructive"
                  aria-label="Remove target"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => onSubmit({ label, kind, targets, op })}>
            {initial ? "Save" : "Add filter"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
