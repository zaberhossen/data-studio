"use client";

/**
 * SaveQueryDialog — names a query for the SavedQueryStore.
 *
 * Collects a name (required), an optional description, and the visualization to
 * restore on open. The query DEFINITION itself comes from the live workspace
 * state — this dialog only captures the metadata. The parent decides whether a
 * submit updates the open record ("Save") or creates a new one ("Save as") via
 * the `intent` it passes to `useQueryWorkspace().persist`.
 *
 * shadcn primitives / tokens: Dialog, Input, Select, Button. States: editing,
 * saving (busy), save error (destructive note), invalid (empty name).
 */

import * as React from "react";
import { Loader2 } from "lucide-react";
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
import type { WidgetViz, WidgetVizType } from "@/lib/types/query";
import type { SaveInput } from "@/hooks/useQueryWorkspace";

const VIZ_OPTIONS: { value: WidgetVizType; label: string }[] = [
  { value: "bar", label: "Bar chart" },
  { value: "line", label: "Line chart" },
  { value: "table", label: "Table" },
  { value: "kpi", label: "KPI" },
];

interface SaveQueryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "save" updates the open record; "saveAs" creates a new one. */
  intent: "save" | "saveAs";
  /** True when a record is currently open (affects the "Save" title/verb). */
  hasOpenRecord: boolean;
  initialName: string;
  initialDescription?: string;
  initialViz: WidgetViz;
  saving: boolean;
  error: string | null;
  onSubmit: (input: SaveInput) => void;
}

export function SaveQueryDialog({
  open,
  onOpenChange,
  intent,
  hasOpenRecord,
  initialName,
  initialDescription,
  initialViz,
  saving,
  error,
  onSubmit,
}: SaveQueryDialogProps) {
  const [name, setName] = React.useState(initialName);
  const [description, setDescription] = React.useState(initialDescription ?? "");
  const [vizType, setVizType] = React.useState<WidgetVizType>(initialViz.type);

  // Re-seed whenever the dialog opens (or its target/intent changes).
  React.useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-seed the editable form fields from props each time the dialog opens
    setName(initialName);
    setDescription(initialDescription ?? "");
    setVizType(initialViz.type);
  }, [open, intent, initialName, initialDescription, initialViz.type]);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !saving;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      name: trimmed,
      description: description.trim() || undefined,
      // Preserve any axis/unit hints already on the viz; only the type is editable here.
      viz: { ...initialViz, type: vizType },
    });
  };

  const title =
    intent === "saveAs" ? "Save query as" : hasOpenRecord ? "Save query" : "Save query";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <label className="space-y-1 block">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Revenue by region"
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              aria-label="Query name"
            />
          </label>

          <label className="space-y-1 block">
            <span className="text-xs font-medium text-muted-foreground">
              Description <span className="font-normal">(optional)</span>
            </span>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this query answers"
              aria-label="Query description"
            />
          </label>

          <label className="space-y-1 block">
            <span className="text-xs font-medium text-muted-foreground">
              Visualization
            </span>
            <Select value={vizType} onValueChange={(v) => setVizType(v as WidgetVizType)}>
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

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {intent === "saveAs" ? "Save as new" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
