"use client";

/**
 * AdvancedQueryBuilder — the IR-driven visual editor (M4).
 *
 * Beyond the legacy builder it supports MULTIPLE metrics, MULTIPLE dimensions
 * with temporal bucketing, and a richer filter set (between / null checks /
 * starts-ends / relative dates). It edits a loose `IrDraft`; the parent compiles
 * it to a `QueryIR` (→ SQL) via `compileIrDraft`. It never touches raw rows.
 *
 * shadcn primitives: Card, Select, Input, Button, Badge. Mirrors QueryBuilder's
 * `Section` layout so the UX matches the existing builder.
 */

import * as React from "react";
import { Play, Plus, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Field } from "@/lib/query/schema";
import type { AggFn, JoinType, TemporalUnit, WindowFn } from "@/lib/query/ir";
import type { ExecutionMode } from "@/lib/types/query";
import type { ExecutionSetting } from "@/hooks/useQueryWorkspace";
import { ExecutionModeToggle } from "./ExecutionModeToggle";
import {
  ALL_IR_AGG_FNS,
  ALL_WINDOW_FNS,
  CALC_OPERATORS,
  IR_AGG_LABELS,
  IR_OPERATOR_LABELS,
  IR_WINDOW_LABELS,
  TEMPORAL_LABELS,
  TEMPORAL_UNITS,
  irOpTakesMultiValue,
  irOpTakesNoValue,
  irOperatorsFor,
  newDraftCalc,
  newDraftDimension,
  newDraftFilter,
  newDraftJoin,
  newDraftMetric,
  newDraftWindow,
  outputNamesForDraft,
  windowFrameable,
  windowNeedsField,
  windowTakesArg,
  type CalcOperand,
  type DraftCalc,
  type DraftDimension,
  type DraftIrFilter,
  type DraftJoin,
  type DraftMetric,
  type DraftWindow,
  type IrCompileResult,
  type IrDraft,
  type IrFilterOp,
} from "@/lib/query/ir-draft";

/** Execution-mode control wiring (optional — omitted when the builder is used
 *  as a pure editor, e.g. inside the Add-widget dialog). */
export interface ExecutionControl {
  value: ExecutionSetting;
  onChange: (mode: ExecutionSetting) => void;
  resolved: ExecutionMode;
  canPushdown: boolean;
}

interface Props {
  fields: Field[];
  datasetName?: string;
  draft: IrDraft;
  onDraftChange: (draft: IrDraft) => void;
  compiled: IrCompileResult;
  /** When omitted the Run button is hidden (editor-only usage). */
  onRun?: () => void;
  running?: boolean;
  /** When provided, renders a Local/Pushdown execution toggle in the card. */
  execution?: ExecutionControl;
}

export function AdvancedQueryBuilder({
  fields,
  datasetName = "Dataset",
  draft,
  onDraftChange,
  compiled,
  onRun,
  running = false,
  execution,
}: Props) {
  const byName = React.useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields]);
  // Hooks must run before any early return (Rules of Hooks) — keep this above
  // the empty-fields guard below.
  const windowCols = React.useMemo(() => outputNamesForDraft(draft, fields), [draft, fields]);
  const patch = (next: Partial<IrDraft>) => onDraftChange({ ...draft, ...next });

  if (fields.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Connect a data source to start building a query.
        </CardContent>
      </Card>
    );
  }

  const canRun = compiled.ir !== null && !running;

  // ── Dimensions ──────────────────────────────────────────────────────────────
  const addDimension = () => patch({ dimensions: [...draft.dimensions, newDraftDimension(fields[0].name)] });
  const updateDimension = (id: string, next: DraftDimension) =>
    patch({ dimensions: draft.dimensions.map((d) => (d.id === id ? next : d)) });
  const removeDimension = (id: string) =>
    patch({ dimensions: draft.dimensions.filter((d) => d.id !== id) });

  // ── Metrics ─────────────────────────────────────────────────────────────────
  const addMetric = () => patch({ metrics: [...draft.metrics, newDraftMetric("count")] });
  const updateMetric = (id: string, next: DraftMetric) =>
    patch({ metrics: draft.metrics.map((m) => (m.id === id ? next : m)) });
  const removeMetric = (id: string) =>
    patch({ metrics: draft.metrics.filter((m) => m.id !== id) });

  // ── Filters ─────────────────────────────────────────────────────────────────
  const addFilter = () => patch({ filters: [...draft.filters, newDraftFilter(fields[0].name)] });
  const updateFilter = (id: string, next: DraftIrFilter) =>
    patch({ filters: draft.filters.map((f) => (f.id === id ? next : f)) });
  const removeFilter = (id: string) =>
    patch({ filters: draft.filters.filter((f) => f.id !== id) });

  // ── Joins ───────────────────────────────────────────────────────────────────
  const joins = draft.joins ?? [];
  const addJoin = () => patch({ joins: [...joins, newDraftJoin()] });
  const updateJoin = (id: string, next: DraftJoin) =>
    patch({ joins: joins.map((j) => (j.id === id ? next : j)) });
  const removeJoin = (id: string) => patch({ joins: joins.filter((j) => j.id !== id) });

  // ── Calculated fields ─────────────────────────────────────────────────────────
  const calcs = draft.calculated ?? [];
  const addCalc = () => patch({ calculated: [...calcs, newDraftCalc()] });
  const updateCalc = (id: string, next: DraftCalc) =>
    patch({ calculated: calcs.map((c) => (c.id === id ? next : c)) });
  const removeCalc = (id: string) => patch({ calculated: calcs.filter((c) => c.id !== id) });

  // ── Window functions ──────────────────────────────────────────────────────────
  const wins = draft.windows ?? [];
  const addWindow = () => patch({ windows: [...wins, newDraftWindow()] });
  const updateWindow = (id: string, next: DraftWindow) =>
    patch({ windows: wins.map((w) => (w.id === id ? next : w)) });
  const removeWindow = (id: string) => patch({ windows: wins.filter((w) => w.id !== id) });

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Advanced query</CardTitle>
          <Badge variant="muted">{datasetName}</Badge>
        </div>
        {onRun && (
          <Button size="sm" onClick={onRun} disabled={!canRun}>
            <Play className="h-3.5 w-3.5" />
            {running ? "Running…" : "Run"}
          </Button>
        )}
      </CardHeader>

      {execution && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-6 pb-3">
          <span className="text-xs font-medium text-muted-foreground">Run on</span>
          <ExecutionModeToggle
            value={execution.value}
            onChange={execution.onChange}
            resolved={execution.resolved}
            canPushdown={execution.canPushdown}
          />
        </div>
      )}

      <CardContent className="flex-1 space-y-6 overflow-auto">
        {/* ── Joins ────────────────────────────────────────────────── */}
        <Section
          title="Joins"
          action={
            <Button variant="outline" size="sm" onClick={addJoin}>
              <Plus className="h-3.5 w-3.5" />
              Add join
            </Button>
          }
        >
          {joins.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No joins — the query reads one table. Joins run on the live database
              (pushdown).
            </p>
          ) : (
            <div className="space-y-2">
              {joins.map((j) => (
                <JoinRow
                  key={j.id}
                  join={j}
                  fields={fields}
                  onChange={(next) => updateJoin(j.id, next)}
                  onRemove={() => removeJoin(j.id)}
                />
              ))}
            </div>
          )}
        </Section>

        {/* ── Dimensions ──────────────────────────────────────────── */}
        <Section
          title="Group by"
          action={
            <Button variant="outline" size="sm" onClick={addDimension}>
              <Plus className="h-3.5 w-3.5" />
              Add dimension
            </Button>
          }
        >
          {draft.dimensions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No dimensions — metrics aggregate over all rows.
            </p>
          ) : (
            <div className="space-y-2">
              {draft.dimensions.map((d) => (
                <DimensionRow
                  key={d.id}
                  dimension={d}
                  fields={fields}
                  field={byName.get(d.column)}
                  onChange={(next) => updateDimension(d.id, next)}
                  onRemove={() => removeDimension(d.id)}
                />
              ))}
            </div>
          )}
        </Section>

        {/* ── Metrics ─────────────────────────────────────────────── */}
        <Section
          title="Metrics"
          action={
            <Button variant="outline" size="sm" onClick={addMetric}>
              <Plus className="h-3.5 w-3.5" />
              Add metric
            </Button>
          }
        >
          {draft.metrics.length === 0 ? (
            <p className="text-xs text-muted-foreground">Add at least one metric.</p>
          ) : (
            <div className="space-y-2">
              {draft.metrics.map((m) => (
                <MetricRow
                  key={m.id}
                  metric={m}
                  fields={fields}
                  onChange={(next) => updateMetric(m.id, next)}
                  onRemove={() => removeMetric(m.id)}
                />
              ))}
            </div>
          )}
        </Section>

        {/* ── Filters ─────────────────────────────────────────────── */}
        <Section
          title="Filters"
          action={
            <Button variant="outline" size="sm" onClick={addFilter}>
              <Plus className="h-3.5 w-3.5" />
              Add filter
            </Button>
          }
        >
          {draft.filters.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No filters — the query runs over all rows.
            </p>
          ) : (
            <div className="space-y-2">
              {draft.filters.map((f) => (
                <IrFilterRow
                  key={f.id}
                  filter={f}
                  fields={fields}
                  field={byName.get(f.column)}
                  onChange={(next) => updateFilter(f.id, next)}
                  onRemove={() => removeFilter(f.id)}
                />
              ))}
            </div>
          )}
        </Section>

        {/* ── Calculated fields ───────────────────────────────────── */}
        <Section
          title="Calculated fields"
          action={
            <Button variant="outline" size="sm" onClick={addCalc}>
              <Plus className="h-3.5 w-3.5" />
              Add field
            </Button>
          }
        >
          {calcs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Derive a new column with arithmetic — e.g. profit = revenue − cost. Shown
              in raw (non-aggregated) listings.
            </p>
          ) : (
            <div className="space-y-2">
              {calcs.map((c) => (
                <CalcRow
                  key={c.id}
                  calc={c}
                  fields={fields}
                  onChange={(next) => updateCalc(c.id, next)}
                  onRemove={() => removeCalc(c.id)}
                />
              ))}
            </div>
          )}
        </Section>

        {/* ── Window functions ────────────────────────────────────── */}
        <Section
          title="Window functions"
          action={
            <Button variant="outline" size="sm" onClick={addWindow}>
              <Plus className="h-3.5 w-3.5" />
              Add window
            </Button>
          }
        >
          {wins.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Running totals, ranks, and lag/lead over the query&apos;s output columns.
            </p>
          ) : (
            <div className="space-y-2">
              {wins.map((w) => (
                <WindowRow
                  key={w.id}
                  win={w}
                  columns={windowCols}
                  onChange={(next) => updateWindow(w.id, next)}
                  onRemove={() => removeWindow(w.id)}
                />
              ))}
            </div>
          )}
        </Section>

        {/* ── Sort + limit ────────────────────────────────────────── */}
        <Section title="Sort & limit">
          <div className="flex flex-wrap gap-2">
            <Select
              value={draft.sortMetricIndex === null ? "none" : String(draft.sortMetricIndex)}
              onValueChange={(v) =>
                patch({ sortMetricIndex: v === "none" ? null : Number(v) })
              }
            >
              <SelectTrigger className="flex-1 min-w-[140px]" aria-label="Sort by metric">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No sort</SelectItem>
                {draft.metrics.map((m, i) => (
                  <SelectItem key={m.id} value={String(i)}>
                    {IR_AGG_LABELS[m.fn]}
                    {m.column ? ` · ${m.column}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={draft.sortDir}
              onValueChange={(v) => patch({ sortDir: v as "asc" | "desc" })}
            >
              <SelectTrigger className="w-36" aria-label="Sort direction">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desc">Highest first</SelectItem>
                <SelectItem value="asc">Lowest first</SelectItem>
              </SelectContent>
            </Select>

            <label className="flex items-center gap-2">
              <span className="whitespace-nowrap text-xs text-muted-foreground">Limit</span>
              <Input
                type="number"
                min={1}
                max={1000}
                value={draft.limit}
                onChange={(e) => patch({ limit: Math.max(1, Number(e.target.value) || 1) })}
                className="w-24"
                aria-label="Row limit"
              />
            </label>
          </div>
        </Section>

        {/* ── Validation summary ──────────────────────────────────── */}
        {compiled.errors.length > 0 && (
          <ul
            className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
            role="status"
          >
            {compiled.errors.map((err, i) => (
              <li key={i}>• {err}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function DimensionRow({
  dimension,
  fields,
  field,
  onChange,
  onRemove,
}: {
  dimension: DraftDimension;
  fields: Field[];
  field: Field | undefined;
  onChange: (next: DraftDimension) => void;
  onRemove: () => void;
}) {
  const isDate = field?.dataType === "date";
  return (
    <div className="flex items-center gap-2">
      <Select
        value={dimension.column}
        onValueChange={(column) => onChange({ ...dimension, column, temporal: undefined })}
      >
        <SelectTrigger className="flex-1" aria-label="Dimension column">
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

      {isDate && (
        <Select
          value={dimension.temporal ?? "none"}
          onValueChange={(v) =>
            onChange({ ...dimension, temporal: v === "none" ? undefined : (v as TemporalUnit) })
          }
        >
          <SelectTrigger className="w-40" aria-label="Bucket by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Raw value</SelectItem>
            {TEMPORAL_UNITS.map((u) => (
              <SelectItem key={u} value={u}>
                {TEMPORAL_LABELS[u]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <IconRemove onClick={onRemove} label="Remove dimension" />
    </div>
  );
}

function MetricRow({
  metric,
  fields,
  onChange,
  onRemove,
}: {
  metric: DraftMetric;
  fields: Field[];
  onChange: (next: DraftMetric) => void;
  onRemove: () => void;
}) {
  const needsColumn = metric.fn !== "count";
  return (
    <div className="flex items-center gap-2">
      <Select value={metric.fn} onValueChange={(v) => onChange({ ...metric, fn: v as AggFn })}>
        <SelectTrigger className="w-40" aria-label="Aggregation">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ALL_IR_AGG_FNS.map((fn) => (
            <SelectItem key={fn} value={fn}>
              {IR_AGG_LABELS[fn]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={metric.column}
        onValueChange={(column) => onChange({ ...metric, column })}
        disabled={!needsColumn}
      >
        <SelectTrigger className="flex-1" aria-label="Metric column">
          <SelectValue placeholder={needsColumn ? "Column" : "All rows"} />
        </SelectTrigger>
        <SelectContent>
          {fields.map((f) => (
            <SelectItem key={f.name} value={f.name}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <IconRemove onClick={onRemove} label="Remove metric" />
    </div>
  );
}

function IrFilterRow({
  filter,
  fields,
  field,
  onChange,
  onRemove,
}: {
  filter: DraftIrFilter;
  fields: Field[];
  field: Field | undefined;
  onChange: (next: DraftIrFilter) => void;
  onRemove: () => void;
}) {
  const ops = field ? irOperatorsFor(field.dataType) : (["eq"] as IrFilterOp[]);

  const onColumnChange = (column: string) => {
    const nextField = fields.find((f) => f.name === column);
    const nextOps = nextField ? irOperatorsFor(nextField.dataType) : ops;
    const op = nextOps.includes(filter.op) ? filter.op : nextOps[0];
    onChange({ ...filter, column, op });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={filter.column} onValueChange={onColumnChange}>
        <SelectTrigger className="min-w-[120px] flex-1" aria-label="Filter column">
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

      <Select value={filter.op} onValueChange={(v) => onChange({ ...filter, op: v as IrFilterOp })}>
        <SelectTrigger className="w-36" aria-label="Operator">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ops.map((op) => (
            <SelectItem key={op} value={op}>
              {IR_OPERATOR_LABELS[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <FilterValueInput filter={filter} onChange={onChange} />

      <IconRemove onClick={onRemove} label="Remove filter" />
    </div>
  );
}

function FilterValueInput({
  filter,
  onChange,
}: {
  filter: DraftIrFilter;
  onChange: (next: DraftIrFilter) => void;
}) {
  if (irOpTakesNoValue(filter.op)) return null;

  if (filter.op === "relative_date") {
    const r = filter.relative;
    return (
      <div className="flex items-center gap-2">
        <Select
          value={r.direction}
          onValueChange={(v) =>
            onChange({ ...filter, relative: { ...r, direction: v as typeof r.direction } })
          }
        >
          <SelectTrigger className="w-28" aria-label="Direction">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="last">Last</SelectItem>
            <SelectItem value="current">This</SelectItem>
            <SelectItem value="next">Next</SelectItem>
          </SelectContent>
        </Select>
        {r.direction !== "current" && (
          <Input
            type="number"
            min={1}
            value={r.count}
            onChange={(e) => onChange({ ...filter, relative: { ...r, count: e.target.value } })}
            className="w-20"
            aria-label="Count"
          />
        )}
        <Select
          value={r.unit}
          onValueChange={(v) =>
            onChange({ ...filter, relative: { ...r, unit: v as typeof r.unit } })
          }
        >
          <SelectTrigger className="w-28" aria-label="Unit">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["day", "week", "month", "quarter", "year"] as const).map((u) => (
              <SelectItem key={u} value={u}>
                {u}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (filter.op === "between") {
    return (
      <div className="flex items-center gap-1">
        <Input
          value={filter.low}
          onChange={(e) => onChange({ ...filter, low: e.target.value })}
          placeholder="min"
          className="w-24"
          aria-label="Between low"
        />
        <span className="text-xs text-muted-foreground">–</span>
        <Input
          value={filter.high}
          onChange={(e) => onChange({ ...filter, high: e.target.value })}
          placeholder="max"
          className="w-24"
          aria-label="Between high"
        />
      </div>
    );
  }

  if (irOpTakesMultiValue(filter.op)) {
    return (
      <Input
        value={filter.values.join(", ")}
        onChange={(e) =>
          onChange({
            ...filter,
            values: e.target.value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean),
          })
        }
        placeholder="a, b, c"
        className="min-w-[140px] flex-1"
        aria-label="Values"
      />
    );
  }

  return (
    <Input
      value={filter.value}
      onChange={(e) => onChange({ ...filter, value: e.target.value })}
      placeholder="value"
      className="min-w-[120px] flex-1"
      aria-label="Value"
    />
  );
}

const JOIN_TYPES: Array<[JoinType, string]> = [
  ["inner", "Inner"],
  ["left", "Left"],
  ["right", "Right"],
  ["full", "Full"],
];

function JoinRow({
  join,
  fields,
  onChange,
  onRemove,
}: {
  join: DraftJoin;
  fields: Field[];
  onChange: (next: DraftJoin) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
      <Select value={join.type} onValueChange={(v) => onChange({ ...join, type: v as JoinType })}>
        <SelectTrigger className="w-24" aria-label="Join type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {JOIN_TYPES.map(([val, label]) => (
            <SelectItem key={val} value={val}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        value={join.table}
        onChange={(e) => onChange({ ...join, table: e.target.value })}
        placeholder="table to join"
        className="w-40"
        aria-label="Join table"
      />

      <span className="text-xs text-muted-foreground">on</span>

      <Select value={join.leftColumn} onValueChange={(v) => onChange({ ...join, leftColumn: v })}>
        <SelectTrigger className="w-40" aria-label="Base column">
          <SelectValue placeholder="base column" />
        </SelectTrigger>
        <SelectContent>
          {fields.map((f) => (
            <SelectItem key={f.name} value={f.name}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <span className="text-xs text-muted-foreground">=</span>

      <Input
        value={join.rightColumn}
        onChange={(e) => onChange({ ...join, rightColumn: e.target.value })}
        placeholder="joined column"
        className="w-40"
        aria-label="Joined column"
      />

      <IconRemove onClick={onRemove} label="Remove join" />
    </div>
  );
}

function CalcRow({
  calc,
  fields,
  onChange,
  onRemove,
}: {
  calc: DraftCalc;
  fields: Field[];
  onChange: (next: DraftCalc) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={calc.name}
        onChange={(e) => onChange({ ...calc, name: e.target.value })}
        placeholder="name"
        className="w-32"
        aria-label="Calculated field name"
      />
      <span className="text-xs text-muted-foreground">=</span>
      <OperandInput
        operand={calc.a}
        fields={fields}
        onChange={(a) => onChange({ ...calc, a })}
      />
      <Select value={calc.operator} onValueChange={(v) => onChange({ ...calc, operator: v as DraftCalc["operator"] })}>
        <SelectTrigger className="w-16" aria-label="Operator">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CALC_OPERATORS.map((op) => (
            <SelectItem key={op} value={op}>
              {op}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <OperandInput
        operand={calc.b}
        fields={fields}
        onChange={(b) => onChange({ ...calc, b })}
      />
      <IconRemove onClick={onRemove} label="Remove calculated field" />
    </div>
  );
}

function OperandInput({
  operand,
  fields,
  onChange,
}: {
  operand: CalcOperand;
  fields: Field[];
  onChange: (next: CalcOperand) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Select value={operand.kind} onValueChange={(v) => onChange({ kind: v as CalcOperand["kind"], value: "" })}>
        <SelectTrigger className="w-24" aria-label="Operand type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="column">Column</SelectItem>
          <SelectItem value="number">Number</SelectItem>
        </SelectContent>
      </Select>
      {operand.kind === "column" ? (
        <Select value={operand.value} onValueChange={(value) => onChange({ ...operand, value })}>
          <SelectTrigger className="w-36" aria-label="Operand column">
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
      ) : (
        <Input
          type="number"
          value={operand.value}
          onChange={(e) => onChange({ ...operand, value: e.target.value })}
          placeholder="0"
          className="w-24"
          aria-label="Operand number"
        />
      )}
    </div>
  );
}

function WindowRow({
  win,
  columns,
  onChange,
  onRemove,
}: {
  win: DraftWindow;
  columns: string[];
  onChange: (next: DraftWindow) => void;
  onRemove: () => void;
}) {
  const NONE = "__none";
  const colSelect = (
    value: string,
    onPick: (v: string) => void,
    label: string,
    placeholder: string,
  ) => (
    <Select value={value || NONE} onValueChange={(v) => onPick(v === NONE ? "" : v)}>
      <SelectTrigger className="w-40" aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{placeholder}</SelectItem>
        {columns.map((c) => (
          <SelectItem key={c} value={c}>
            {c}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
      <Select value={win.fn} onValueChange={(v) => onChange({ ...newDraftWindow(v as WindowFn), id: win.id, alias: win.alias })}>
        <SelectTrigger className="w-52" aria-label="Window function">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ALL_WINDOW_FNS.map((fn) => (
            <SelectItem key={fn} value={fn}>
              {IR_WINDOW_LABELS[fn]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {windowNeedsField(win.fn) && (
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          of
          {colSelect(win.column, (v) => onChange({ ...win, column: v }), "Value column", "column")}
        </label>
      )}

      {windowTakesArg(win.fn) && (
        <Input
          type="number"
          min={1}
          value={win.arg}
          onChange={(e) => onChange({ ...win, arg: e.target.value })}
          placeholder={win.fn === "ntile" ? "buckets" : "offset"}
          className="w-24"
          aria-label="Window argument"
        />
      )}

      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        by
        {colSelect(win.partition, (v) => onChange({ ...win, partition: v }), "Partition by", "(no partition)")}
      </label>

      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        order
        {colSelect(win.orderColumn, (v) => onChange({ ...win, orderColumn: v }), "Order by", "(unordered)")}
      </label>

      {win.orderColumn && (
        <Select value={win.orderDir} onValueChange={(v) => onChange({ ...win, orderDir: v as "asc" | "desc" })}>
          <SelectTrigger className="w-24" aria-label="Order direction">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="asc">Asc</SelectItem>
            <SelectItem value="desc">Desc</SelectItem>
          </SelectContent>
        </Select>
      )}

      {windowFrameable(win.fn) && (
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={win.running}
            onChange={(e) => onChange({ ...win, running: e.target.checked })}
          />
          Running
        </label>
      )}

      <Input
        value={win.alias}
        onChange={(e) => onChange({ ...win, alias: e.target.value })}
        placeholder="alias"
        className="w-28"
        aria-label="Window alias"
      />

      <IconRemove onClick={onRemove} label="Remove window" />
    </div>
  );
}

function IconRemove({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button variant="ghost" size="icon" onClick={onClick} aria-label={label}>
      <Trash2 className="h-3.5 w-3.5" />
    </Button>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}
