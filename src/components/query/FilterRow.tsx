"use client";

/**
 * FilterRow — one editable filter: [column] [operator] [value] [remove].
 *
 * The operator list narrows to what the chosen column's data-type supports
 * (`operatorsFor`), and the value control swaps by shape:
 *   • in_list  → MultiValueInput (chips)
 *   • boolean  → Select (true/false)
 *   • else     → Input (text/number)
 * Changing the column re-snaps the operator to a valid one for the new type.
 *
 * shadcn primitives: Select, Input, Button (icon), Badge (via MultiValueInput).
 * States: complete, incomplete (empty value — surfaced by the builder's
 * validation), in_list multi-value.
 */

import * as React from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  OPERATOR_LABELS,
  isMultiValueOperator,
  operatorsFor,
  type DraftFilter,
  type Field,
} from "@/lib/query/schema";
import { MultiValueInput } from "./MultiValueInput";

interface FilterRowProps {
  filter: DraftFilter;
  fields: Field[];
  onChange: (next: DraftFilter) => void;
  onRemove: () => void;
}

export function FilterRow({
  filter,
  fields,
  onChange,
  onRemove,
}: FilterRowProps) {
  const field = fields.find((f) => f.name === filter.column);
  const operators = field ? operatorsFor(field.dataType) : [];

  const handleColumn = (column: string) => {
    const nextField = fields.find((f) => f.name === column);
    const ops = nextField ? operatorsFor(nextField.dataType) : [];
    // Keep the current operator if still valid, else fall back to the first.
    const operator = ops.includes(filter.operator) ? filter.operator : ops[0];
    onChange({ ...filter, column, operator });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background p-2">
      <Select value={filter.column} onValueChange={handleColumn}>
        <SelectTrigger className="h-8 w-32" aria-label="Filter column">
          <SelectValue placeholder="Column" />
        </SelectTrigger>
        <SelectContent>
          {fields.map((f) => (
            <SelectItem key={f.name} value={f.name}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filter.operator}
        onValueChange={(op) =>
          onChange({ ...filter, operator: op as DraftFilter["operator"] })
        }
        disabled={!field}
      >
        <SelectTrigger className="h-8 w-28" aria-label="Filter operator">
          <SelectValue placeholder="Op" />
        </SelectTrigger>
        <SelectContent>
          {operators.map((op) => (
            <SelectItem key={op} value={op}>
              {OPERATOR_LABELS[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="min-w-[10rem] flex-1">
        {field && isMultiValueOperator(filter.operator) ? (
          <MultiValueInput
            values={filter.values}
            onChange={(values) => onChange({ ...filter, values })}
            aria-label="Filter values"
          />
        ) : field?.dataType === "boolean" ? (
          <Select
            value={filter.value}
            onValueChange={(value) => onChange({ ...filter, value })}
          >
            <SelectTrigger className="h-8" aria-label="Filter value">
              <SelectValue placeholder="Value" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">true</SelectItem>
              <SelectItem value="false">false</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={filter.value}
            onChange={(e) => onChange({ ...filter, value: e.target.value })}
            inputMode={field?.dataType === "number" ? "decimal" : "text"}
            placeholder={field ? "Value" : "Pick a column first"}
            disabled={!field}
            aria-label="Filter value"
            className="h-8"
          />
        )}
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
        aria-label="Remove filter"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}
