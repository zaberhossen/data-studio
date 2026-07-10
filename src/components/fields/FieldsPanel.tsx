"use client";

/**
 * FieldsPanel — schema browser + curation for the active data source.
 *
 * Lists every column with its introspected data type (fixed) and lets the
 * user override its role (dimension/metric) and display label. Overrides
 * persist per source (`useDataSources`'s `setFieldOverride`/`resetFieldOverride`)
 * and flow straight into the existing `activeFields`, so QueryBuilder and
 * SqlEditor pick them up with no changes of their own.
 *
 * shadcn primitives: Badge, Select, Input, Button.
 * States: no active source, schema still loading, populated.
 */

import * as React from "react";
import { RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DataSourcesApi } from "@/hooks/useDataSources";
import type { Field, FieldRole } from "@/lib/query/schema";

interface FieldsPanelProps {
  sources: DataSourcesApi;
}

const ROLE_LABEL: Record<FieldRole, string> = {
  dimension: "Dimension",
  metric: "Metric",
};

export function FieldsPanel({ sources }: FieldsPanelProps) {
  const { activeSource, activeFields, fieldOverrides, setFieldOverride, resetFieldOverride } =
    sources;

  if (!activeSource) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <p className="text-sm font-medium">No data source selected</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Activate a data source to browse and curate its fields.
          </p>
        </div>
      </div>
    );
  }

  if (activeSource.status !== "ready" || activeFields.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          {activeSource.status === "connecting"
            ? "Loading schema…"
            : "No fields available for this source."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-sm font-medium">{activeSource.name}</span>
        <span className="text-xs text-muted-foreground">
          {activeFields.length} {activeFields.length === 1 ? "field" : "fields"}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
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
              {activeFields.map((f) => (
                <FieldRow
                  key={f.name}
                  field={f}
                  overridden={!!fieldOverrides[f.name]}
                  onRoleChange={(role) =>
                    void setFieldOverride(activeSource.id, f.name, { role })
                  }
                  onLabelCommit={(label) =>
                    void setFieldOverride(activeSource.id, f.name, { label })
                  }
                  onReset={() => void resetFieldOverride(activeSource.id, f.name)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
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
