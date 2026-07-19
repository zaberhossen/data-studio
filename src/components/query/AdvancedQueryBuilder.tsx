"use client";

/**
 * AdvancedQueryBuilder — the IR-driven visual editor, laid out as a Metabase
 * style NOTEBOOK with Supabase styling: colored step blocks (Data → Joins →
 * Custom columns → Filter → Summarize → Metric filters → Windows → Sort →
 * Row limit) whose contents render as PILLS. Clicking a pill opens a popover
 * holding the full editor for that item; the × on a pill removes it. Optional
 * steps stay hidden until used — the action row at the bottom adds the first
 * item (and auto-opens its editor).
 *
 * Surface: nested AND/OR/NOT filter groups, HAVING conditions over the
 * metrics, multi-key sort over output columns, dimension/metric aliases,
 * multi-condition joins, multi-column window partition/order, calculated
 * fields as formulas (`expr-text.ts`), a data-step column picker (raw mode),
 * and a per-step 10-row PREVIEW (`draftUpToStep` + the parent's `onPreview`
 * runner — the rows come from the worker and are never held in parent state).
 *
 * It edits a loose `IrDraft`; the parent compiles it to a `QueryIR` (→ SQL)
 * via `compileIrDraft`. */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ExecutionSetting } from "@/hooks/useQueryWorkspace";
import type { AggFn, JoinType, TemporalUnit, WindowFn } from "@/lib/query/ir";
import { EXPR_FNS, parseExprText } from "@/lib/query/expr-text";
import { columnRef, spliceSnippet } from "@/lib/query/formula-insert";
import {
  ALL_IR_AGG_FNS,
  ALL_WINDOW_FNS,
  HAVING_OPS,
  IR_OPERATOR_LABELS,
  IR_WINDOW_LABELS,
  TEMPORAL_LABELS,
  TEMPORAL_UNITS,
  aggIsConditional,
  aggNeedsColumn,
  aggTakesFraction,
  draftMetricAlias,
  irOpTakesMultiValue,
  irOpTakesNoValue,
  irOperatorsFor,
  isDraftGroup,
  newDraftCalc,
  newDraftDimension,
  newDraftFilter,
  newDraftFilterGroup,
  newDraftHaving,
  newDraftJoin,
  newDraftJoinCondition,
  newDraftMetric,
  newDraftSort,
  newDraftWindow,
  newDraftWindowOrder,
  outputNamesForDraft,
  sortableNamesForDraft,
  draftUpToStep,
  windowFrameable,
  windowNeedsField,
  windowTakesArg,
  type BuilderStep,
  type DraftCalc,
  type DraftDimension,
  type DraftFilterGroup,
  type DraftFilterNode,
  type DraftHaving,
  type DraftIrFilter,
  type DraftJoin,
  type DraftMetric,
  type DraftSort,
  type DraftWindow,
  type HavingOp,
  type IrCompileResult,
  type IrDraft,
  type IrFilterOp,
} from "@/lib/query/ir-draft";
import type { Field } from "@/lib/query/schema";
import type { ExecutionMode } from "@/lib/types/query";
import { cn } from "@/lib/utils";
import {
  ArrowUpDown,
  Calculator,
  Filter as FilterIcon,
  GitMerge,
  ListFilter,
  Loader2,
  Play,
  Plus,
  Table2,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";
import * as React from "react";
import { ExecutionModeToggle } from "./ExecutionModeToggle";
import { MultiValueInput } from "./MultiValueInput";

/** Execution-mode control wiring (optional — omitted when the builder is used
 *  as a pure editor, e.g. inside the Add-widget dialog). */
export interface ExecutionControl {
  value: ExecutionSetting;
  onChange: (mode: ExecutionSetting) => void;
  resolved: ExecutionMode;
  canPushdown: boolean;
}

/** One bounded preview page — at most 10 rows, produced by the parent's runner. */
export interface PreviewData {
  columns: string[];
  rows: unknown[][];
}

type PreviewState =
  | { step: BuilderStep; status: "loading" }
  | { step: BuilderStep; status: "data"; data: PreviewData }
  | { step: BuilderStep; status: "error"; error: string };

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
  /**
   * Per-step preview runner: compile + run the truncated draft (LOCAL, 10
   * rows) and resolve the page. Omitted ⇒ preview buttons are hidden.
   */
  onPreview?: (draft: IrDraft) => Promise<PreviewData>;
  /**
   * Drop the card header (title/badge/Run) and execution row and render only the
   * notebook. Used by the /editor page, which hoists those controls into its
   * own toolbar; the Add-widget dialog leaves this off to keep the framed header.
   */
  chromeless?: boolean;
}

// ── Notebook step palette ─────────────────────────────────────────────────────
// Metabase's section color-coding in Supabase-calibrated tones (`--nb-*` in
// globals.css). Solid pills in light mode, tinted pills in dark. All class
// strings are static so Tailwind JIT can see them.

type NbTone = "data" | "filter" | "summarize" | "window" | "neutral";

const NB: Record<
  NbTone,
  { block: string; title: string; pill: string; soft: string; well: string; preview: string }
> = {
  data: {
    block: "border-[hsl(var(--nb-data)/0.3)] bg-[hsl(var(--nb-data)/0.05)]",
    title: "text-[hsl(var(--nb-data))]",
    pill:
      "border-transparent bg-[hsl(var(--nb-data))] text-white hover:bg-[hsl(var(--nb-data)/0.85)] dark:border-[hsl(var(--nb-data)/0.4)] dark:bg-[hsl(var(--nb-data)/0.15)] dark:text-[hsl(var(--nb-data))] dark:hover:bg-[hsl(var(--nb-data)/0.25)]",
    soft:
      "border-transparent bg-[hsl(var(--nb-data)/0.12)] text-[hsl(var(--nb-data))] hover:bg-[hsl(var(--nb-data)/0.2)]",
    well: "bg-[hsl(var(--nb-data)/0.07)]",
    preview: "text-[hsl(var(--nb-data))] hover:bg-[hsl(var(--nb-data)/0.12)]",
  },
  filter: {
    block: "border-[hsl(var(--nb-filter)/0.3)] bg-[hsl(var(--nb-filter)/0.05)]",
    title: "text-[hsl(var(--nb-filter))]",
    pill:
      "border-transparent bg-[hsl(var(--nb-filter))] text-white hover:bg-[hsl(var(--nb-filter)/0.85)] dark:border-[hsl(var(--nb-filter)/0.4)] dark:bg-[hsl(var(--nb-filter)/0.15)] dark:text-[hsl(var(--nb-filter))] dark:hover:bg-[hsl(var(--nb-filter)/0.25)]",
    soft:
      "border-transparent bg-[hsl(var(--nb-filter)/0.12)] text-[hsl(var(--nb-filter))] hover:bg-[hsl(var(--nb-filter)/0.2)]",
    well: "bg-[hsl(var(--nb-filter)/0.07)]",
    preview: "text-[hsl(var(--nb-filter))] hover:bg-[hsl(var(--nb-filter)/0.12)]",
  },
  summarize: {
    block: "border-[hsl(var(--nb-summarize)/0.3)] bg-[hsl(var(--nb-summarize)/0.05)]",
    title: "text-[hsl(var(--nb-summarize))]",
    pill:
      "border-transparent bg-[hsl(var(--nb-summarize))] text-white hover:bg-[hsl(var(--nb-summarize)/0.85)] dark:border-[hsl(var(--nb-summarize)/0.4)] dark:bg-[hsl(var(--nb-summarize)/0.15)] dark:text-[hsl(var(--nb-summarize))] dark:hover:bg-[hsl(var(--nb-summarize)/0.25)]",
    soft:
      "border-transparent bg-[hsl(var(--nb-summarize)/0.12)] text-[hsl(var(--nb-summarize))] hover:bg-[hsl(var(--nb-summarize)/0.2)]",
    well: "bg-[hsl(var(--nb-summarize)/0.07)]",
    preview: "text-[hsl(var(--nb-summarize))] hover:bg-[hsl(var(--nb-summarize)/0.12)]",
  },
  window: {
    block: "border-[hsl(var(--nb-window)/0.3)] bg-[hsl(var(--nb-window)/0.05)]",
    title: "text-[hsl(var(--nb-window))]",
    pill:
      "border-transparent bg-[hsl(var(--nb-window))] text-white hover:bg-[hsl(var(--nb-window)/0.85)] dark:border-[hsl(var(--nb-window)/0.4)] dark:bg-[hsl(var(--nb-window)/0.15)] dark:text-[hsl(var(--nb-window))] dark:hover:bg-[hsl(var(--nb-window)/0.25)]",
    soft:
      "border-transparent bg-[hsl(var(--nb-window)/0.12)] text-[hsl(var(--nb-window))] hover:bg-[hsl(var(--nb-window)/0.2)]",
    well: "bg-[hsl(var(--nb-window)/0.07)]",
    preview: "text-[hsl(var(--nb-window))] hover:bg-[hsl(var(--nb-window)/0.12)]",
  },
  neutral: {
    block: "border-border bg-surface-100",
    title: "text-foreground-light",
    pill:
      "border-border-strong bg-surface-200 text-foreground hover:bg-surface-300 dark:bg-surface-300",
    soft: "border-transparent bg-surface-300 text-foreground-light hover:text-foreground",
    well: "bg-surface-200",
    preview: "text-muted-foreground hover:bg-surface-300",
  },
};

// ── Pill labels (humanized summaries) ─────────────────────────────────────────

const AGG_PILL_LABELS: Record<AggFn, string> = {
  sum: "Sum",
  avg: "Average",
  count: "Count",
  count_distinct: "Distinct count",
  min: "Min",
  max: "Max",
  median: "Median",
  stddev: "Std dev",
  variance: "Variance",
  percentile: "Percentile",
  count_if: "Count if",
  sum_if: "Sum if",
};

const HAVING_LABELS: Record<HavingOp, string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  between: "between",
};

function fieldLabel(name: string, byName: Map<string, Field>): string {
  return byName.get(name)?.label ?? (name || "…");
}

function filterPillLabel(f: DraftIrFilter, byName: Map<string, Field>): string {
  const col = fieldLabel(f.column, byName);
  const op = IR_OPERATOR_LABELS[f.op];
  if (irOpTakesNoValue(f.op)) return `${col} ${op}`;
  if (f.op === "relative_date") {
    const r = f.relative;
    if (r.direction === "current") return `${col} is this ${r.unit}`;
    const unit = Number(r.count) === 1 ? r.unit : `${r.unit}s`;
    return `${col} is in the ${r.direction} ${r.count || "…"} ${unit}`;
  }
  if (f.op === "between") return `${col} between ${f.low || "…"} and ${f.high || "…"}`;
  if (irOpTakesMultiValue(f.op)) {
    const shown = f.values.slice(0, 3).join(", ");
    const more = f.values.length > 3 ? `, +${f.values.length - 3}` : "";
    return `${col} ${op} (${f.values.length ? shown + more : "…"})`;
  }
  return `${col} ${op} ${f.value || "…"}`;
}

function groupPillLabel(g: DraftFilterGroup): string {
  const n = g.children.length;
  const cond = n === 1 ? "condition" : "conditions";
  return `${g.not ? "NOT " : ""}${n} ${cond} (${g.op.toUpperCase()})`;
}

function metricCondLabel(m: DraftMetric, byName: Map<string, Field>): string {
  if (!m.cond?.column) return "…";
  const col = fieldLabel(m.cond.column, byName);
  const op = IR_OPERATOR_LABELS[m.cond.op];
  if (m.cond.op === "is_null" || m.cond.op === "not_null") return `${col} ${op}`;
  return `${col} ${op} ${m.cond.value || "…"}`;
}

function metricPillLabel(m: DraftMetric, byName: Map<string, Field>): string {
  let base: string;
  if (m.fn === "count") {
    base = "Count";
  } else if (m.fn === "count_if") {
    base = `Count if ${metricCondLabel(m, byName)}`;
  } else if (m.fn === "sum_if") {
    base = `Sum of ${fieldLabel(m.column, byName)} if ${metricCondLabel(m, byName)}`;
  } else if (m.fn === "percentile") {
    base = `P${m.p || "…"} of ${fieldLabel(m.column, byName)}`;
  } else {
    base = `${AGG_PILL_LABELS[m.fn]} of ${fieldLabel(m.column, byName)}`;
  }
  return m.alias?.trim() ? `${base} as ${m.alias.trim()}` : base;
}

function dimensionPillLabel(d: DraftDimension, byName: Map<string, Field>): string {
  const base = fieldLabel(d.column, byName);
  let shaped = base;
  if (d.temporal) shaped = `${base}: ${TEMPORAL_LABELS[d.temporal]}`;
  else if (d.bin != null && d.bin.trim() !== "") shaped = `${base}: bins of ${d.bin.trim()}`;
  return d.alias?.trim() ? `${shaped} as ${d.alias.trim()}` : shaped;
}

function havingPillLabel(h: DraftHaving, metrics: DraftMetric[]): string {
  const m = h.metricIndex === null ? undefined : metrics[h.metricIndex];
  const name = m ? draftMetricAlias(m, h.metricIndex ?? 0) : "metric…";
  if (h.op === "between") return `${name} between ${h.low || "…"} and ${h.high || "…"}`;
  return `${name} ${HAVING_LABELS[h.op]} ${h.value || "…"}`;
}

function joinPillLabel(j: DraftJoin): string {
  const table = j.table.trim() || "table…";
  const on = j.conditions.filter((c) => c.left && c.right).length;
  return `${j.type.charAt(0).toUpperCase()}${j.type.slice(1)} join ${table}${on > 0 ? ` (${on} on)` : ""}`;
}

function calcPillLabel(c: DraftCalc): string {
  const name = c.name.trim() || "new field";
  const text = c.text.trim();
  const short = text.length > 28 ? `${text.slice(0, 28)}…` : text;
  return short ? `${name} = ${short}` : name;
}

function windowPillLabel(w: DraftWindow): string {
  const base = windowNeedsField(w.fn)
    ? `${IR_WINDOW_LABELS[w.fn]} of ${w.column || "…"}`
    : IR_WINDOW_LABELS[w.fn];
  return w.alias.trim() ? `${base} as ${w.alias.trim()}` : base;
}

function sortPillLabel(s: DraftSort): string {
  return `${s.column || "…"} ${s.dir === "desc" ? "↓" : "↑"}`;
}

// ── Filter-tree helpers (pure) ────────────────────────────────────────────────

/** Replace (fn returns a node) or delete (fn returns null) the node with `id`. */
function mapFilterNodes(
  nodes: DraftFilterNode[],
  id: string,
  fn: (node: DraftFilterNode) => DraftFilterNode | null,
): DraftFilterNode[] {
  const out: DraftFilterNode[] = [];
  for (const node of nodes) {
    if (node.id === id) {
      const next = fn(node);
      if (next) out.push(next);
      continue;
    }
    if (isDraftGroup(node)) {
      out.push({ ...node, children: mapFilterNodes(node.children, id, fn) });
    } else {
      out.push(node);
    }
  }
  return out;
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
  onPreview,
  chromeless = false,
}: Props) {
  const byName = React.useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields]);
  // Hooks must run before any early return (Rules of Hooks) — keep this above
  // the empty-fields guard below.
  const windowCols = React.useMemo(() => outputNamesForDraft(draft, fields), [draft, fields]);
  const sortCols = React.useMemo(() => sortableNamesForDraft(draft, fields), [draft, fields]);
  const patch = (next: Partial<IrDraft>) => onDraftChange({ ...draft, ...next });

  // One pill editor open at a time; newly added items auto-open theirs.
  const [openId, setOpenId] = React.useState<string | null>(null);
  const pillOpen = (id: string) => ({
    open: openId === id,
    onOpenChange: (o: boolean) => setOpenId(o ? id : null),
  });

  // Per-step preview — one open panel at a time; stale responses are dropped.
  const [preview, setPreview] = React.useState<PreviewState | null>(null);
  const previewSeq = React.useRef(0);
  const runPreview = React.useMemo(() => {
    if (!onPreview) return undefined;
    return (step: BuilderStep) => {
      previewSeq.current += 1;
      const seq = previewSeq.current;
      setPreview({ step, status: "loading" });
      onPreview(draftUpToStep(draft, step))
        .then((data) => {
          if (previewSeq.current === seq) setPreview({ step, status: "data", data });
        })
        .catch((err: unknown) => {
          if (previewSeq.current === seq) {
            setPreview({
              step,
              status: "error",
              error: err instanceof Error ? err.message : "Preview failed.",
            });
          }
        });
    };
  }, [onPreview, draft]);
  const closePreview = React.useCallback(() => setPreview(null), []);
  const previewProps = {
    onPreviewStep: runPreview,
    previewState: preview,
    onClosePreview: closePreview,
  };

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
  const aggregating = draft.dimensions.length > 0 || draft.metrics.length > 0;

  // ── Dimensions ──────────────────────────────────────────────────────────────
  const addDimension = () => {
    const d = newDraftDimension(fields[0].name);
    patch({ dimensions: [...draft.dimensions, d] });
    setOpenId(d.id);
  };
  const updateDimension = (id: string, next: DraftDimension) =>
    patch({ dimensions: draft.dimensions.map((d) => (d.id === id ? next : d)) });
  const removeDimension = (id: string) =>
    patch({ dimensions: draft.dimensions.filter((d) => d.id !== id) });

  // ── Metrics ─────────────────────────────────────────────────────────────────
  const addMetric = () => {
    const m = newDraftMetric("count");
    patch({ metrics: [...draft.metrics, m] });
    setOpenId(m.id);
  };
  const updateMetric = (id: string, next: DraftMetric) =>
    patch({ metrics: draft.metrics.map((m) => (m.id === id ? next : m)) });
  const removeMetric = (id: string) =>
    patch({ metrics: draft.metrics.filter((m) => m.id !== id) });

  // ── Filters (tree) ───────────────────────────────────────────────────────────
  const addFilter = () => {
    const f = newDraftFilter(fields[0].name);
    patch({ filters: [...draft.filters, f] });
    setOpenId(f.id);
  };
  const addFilterGroup = () => {
    const g = newDraftFilterGroup("or");
    patch({ filters: [...draft.filters, g] });
    setOpenId(g.id);
  };
  const updateFilterNode = (id: string, next: DraftFilterNode) =>
    patch({ filters: mapFilterNodes(draft.filters, id, () => next) });
  const removeFilterNode = (id: string) =>
    patch({ filters: mapFilterNodes(draft.filters, id, () => null) });
  const addChildTo = (groupId: string, child: DraftFilterNode) =>
    patch({
      filters: mapFilterNodes(draft.filters, groupId, (n) =>
        isDraftGroup(n) ? { ...n, children: [...n.children, child] } : n,
      ),
    });

  // ── Having ──────────────────────────────────────────────────────────────────
  const addHaving = () => {
    const h = newDraftHaving();
    patch({ having: [...draft.having, h] });
    setOpenId(h.id);
  };
  const updateHaving = (id: string, next: DraftHaving) =>
    patch({ having: draft.having.map((h) => (h.id === id ? next : h)) });
  const removeHaving = (id: string) =>
    patch({ having: draft.having.filter((h) => h.id !== id) });

  // ── Sort ────────────────────────────────────────────────────────────────────
  const addSort = () => {
    const s = newDraftSort(sortCols[0] ?? "");
    patch({ sort: [...draft.sort, s] });
    setOpenId(s.id);
  };
  const updateSort = (id: string, next: DraftSort) =>
    patch({ sort: draft.sort.map((s) => (s.id === id ? next : s)) });
  const removeSort = (id: string) => patch({ sort: draft.sort.filter((s) => s.id !== id) });

  // ── Joins ───────────────────────────────────────────────────────────────────
  const joins = draft.joins ?? [];
  const addJoin = () => {
    const j = newDraftJoin();
    patch({ joins: [...joins, j] });
    setOpenId(j.id);
  };
  const updateJoin = (id: string, next: DraftJoin) =>
    patch({ joins: joins.map((j) => (j.id === id ? next : j)) });
  const removeJoin = (id: string) => patch({ joins: joins.filter((j) => j.id !== id) });

  // ── Calculated fields ─────────────────────────────────────────────────────────
  const calcs = draft.calculated ?? [];
  const addCalc = () => {
    const c = newDraftCalc();
    patch({ calculated: [...calcs, c] });
    setOpenId(c.id);
  };
  const updateCalc = (id: string, next: DraftCalc) =>
    patch({ calculated: calcs.map((c) => (c.id === id ? next : c)) });
  const removeCalc = (id: string) => patch({ calculated: calcs.filter((c) => c.id !== id) });

  // ── Window functions ──────────────────────────────────────────────────────────
  const wins = draft.windows ?? [];
  const addWindow = () => {
    const w = newDraftWindow();
    patch({ windows: [...wins, w] });
    setOpenId(w.id);
  };
  const updateWindow = (id: string, next: DraftWindow) =>
    patch({ windows: wins.map((w) => (w.id === id ? next : w)) });
  const removeWindow = (id: string) => patch({ windows: wins.filter((w) => w.id !== id) });

  const rawSelected = draft.rawColumns?.length ?? 0;

  const notebook = (
    <div className="space-y-3">
      {/* ── Data ────────────────────────────────────────────────── */}
      <NotebookBlock tone="data" title="Data" step="data" {...previewProps}>
        <div className="flex flex-wrap items-center gap-2">
          <Pill
            tone="data"
            label={datasetName}
            icon={<Table2 className="h-3.5 w-3.5" />}
            {...pillOpen("__data")}
          >
            {aggregating ? (
              <p className="max-w-[280px] text-xs text-muted-foreground">
                This query aggregates — its output is defined by Summarize
                (metrics + group by). Column selection applies to raw listings.
              </p>
            ) : (
              <div className="w-[360px] max-w-[80vw]">
                <p className="mb-2 text-xs font-medium text-foreground-light">
                  Columns to include
                </p>
                <DataColumnPicker
                  fields={fields}
                  rawColumns={draft.rawColumns ?? []}
                  onChange={(rawColumns) => patch({ rawColumns })}
                />
              </div>
            )}
          </Pill>
          <span className="text-xs text-muted-foreground">
            {fields.length} columns
            {!aggregating && rawSelected > 0 ? ` · ${rawSelected} selected` : ""}
          </span>
        </div>
      </NotebookBlock>

      {/* ── Joins ───────────────────────────────────────────────── */}
      {joins.length > 0 && (
        <NotebookBlock tone="data" title="Join data" step="joins" {...previewProps}>
          <div className="flex flex-wrap items-center gap-1.5">
            {joins.map((j) => (
              <Pill
                key={j.id}
                tone="data"
                label={joinPillLabel(j)}
                onRemove={() => removeJoin(j.id)}
                wide
                {...pillOpen(j.id)}
              >
                <JoinRow
                  join={j}
                  fields={fields}
                  onChange={(next) => updateJoin(j.id, next)}
                />
              </Pill>
            ))}
            <AddPill tone="data" onClick={addJoin} label="Add a join" />
          </div>
        </NotebookBlock>
      )}

      {/* ── Calculated fields (custom columns) ──────────────────── */}
      {calcs.length > 0 && (
        <NotebookBlock tone="neutral" title="Custom columns" step="calculated" {...previewProps}>
          <div className="flex flex-wrap items-center gap-1.5">
            {calcs.map((c) => (
              <Pill
                key={c.id}
                tone="neutral"
                label={calcPillLabel(c)}
                mono
                onRemove={() => removeCalc(c.id)}
                wide
                {...pillOpen(c.id)}
              >
                <CalcRow calc={c} fields={fields} onChange={(next) => updateCalc(c.id, next)} />
              </Pill>
            ))}
            <AddPill tone="neutral" onClick={addCalc} label="Add a custom column" />
          </div>
        </NotebookBlock>
      )}

      {/* ── Filters (tree) ──────────────────────────────────────── */}
      {draft.filters.length > 0 && (
        <NotebookBlock tone="filter" title="Filter" step="filters" {...previewProps}>
          <div className="flex flex-wrap items-center gap-1.5">
            {draft.filters.map((node) =>
              isDraftGroup(node) ? (
                <Pill
                  key={node.id}
                  tone="filter"
                  label={groupPillLabel(node)}
                  onRemove={() => removeFilterNode(node.id)}
                  wide
                  {...pillOpen(node.id)}
                >
                  <FilterGroupView
                    group={node}
                    fields={fields}
                    byName={byName}
                    onChange={(next) => updateFilterNode(node.id, next)}
                    onAddChild={(groupId, child) => addChildTo(groupId, child)}
                  />
                </Pill>
              ) : (
                <Pill
                  key={node.id}
                  tone="filter"
                  label={filterPillLabel(node, byName)}
                  onRemove={() => removeFilterNode(node.id)}
                  wide
                  {...pillOpen(node.id)}
                >
                  <IrFilterRow
                    filter={node}
                    fields={fields}
                    field={byName.get(node.column)}
                    onChange={(next) => updateFilterNode(node.id, next)}
                  />
                </Pill>
              ),
            )}
            <AddPill tone="filter" onClick={addFilter} label="Add a filter" />
            <button
              type="button"
              onClick={addFilterGroup}
              className="rounded-md px-1.5 py-1 text-[11px] font-medium text-[hsl(var(--nb-filter))] hover:bg-[hsl(var(--nb-filter)/0.12)]"
              title="Add an OR/AND group"
            >
              + Group
            </button>
          </div>
        </NotebookBlock>
      )}

      {/* ── Summarize (metrics by dimensions) ───────────────────── */}
      <NotebookBlock tone="summarize" title="Summarize" step="summarize" {...previewProps}>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className={cn(
              "flex min-w-[180px] flex-1 flex-wrap items-center gap-1.5 rounded-md p-1.5",
              NB.summarize.well,
            )}
          >
            {draft.metrics.map((m) => (
              <Pill
                key={m.id}
                tone="summarize"
                label={metricPillLabel(m, byName)}
                onRemove={() => removeMetric(m.id)}
                {...pillOpen(m.id)}
              >
                <MetricRow
                  metric={m}
                  fields={fields}
                  onChange={(next) => updateMetric(m.id, next)}
                />
              </Pill>
            ))}
            {draft.metrics.length === 0 && (
              <span className="px-1 text-xs text-muted-foreground">
                Pick a metric to aggregate
              </span>
            )}
            <AddPill tone="summarize" onClick={addMetric} label="Add a metric" />
          </div>

          <span className={cn("text-sm font-medium", NB.summarize.title)}>by</span>

          <div
            className={cn(
              "flex min-w-[180px] flex-1 flex-wrap items-center gap-1.5 rounded-md p-1.5",
              NB.summarize.well,
            )}
          >
            {draft.dimensions.map((d) => (
              <Pill
                key={d.id}
                tone="summarize"
                label={dimensionPillLabel(d, byName)}
                onRemove={() => removeDimension(d.id)}
                {...pillOpen(d.id)}
              >
                <DimensionRow
                  dimension={d}
                  fields={fields}
                  field={byName.get(d.column)}
                  onChange={(next) => updateDimension(d.id, next)}
                />
              </Pill>
            ))}
            {draft.dimensions.length === 0 && (
              <span className="px-1 text-xs text-muted-foreground">
                All rows (no grouping)
              </span>
            )}
            <AddPill tone="summarize" onClick={addDimension} label="Add a group-by" />
          </div>
        </div>
      </NotebookBlock>

      {/* ── Having (post-aggregation) ───────────────────────────── */}
      {draft.metrics.length > 0 && draft.having.length > 0 && (
        <NotebookBlock tone="summarize" title="Metric filters" step="having" {...previewProps}>
          <div className="flex flex-wrap items-center gap-1.5">
            {draft.having.map((h) => (
              <Pill
                key={h.id}
                tone="summarize"
                label={havingPillLabel(h, draft.metrics)}
                onRemove={() => removeHaving(h.id)}
                {...pillOpen(h.id)}
              >
                <HavingRow
                  having={h}
                  metrics={draft.metrics}
                  onChange={(next) => updateHaving(h.id, next)}
                />
              </Pill>
            ))}
            <AddPill tone="summarize" onClick={addHaving} label="Add a metric filter" />
          </div>
        </NotebookBlock>
      )}

      {/* ── Window functions ────────────────────────────────────── */}
      {wins.length > 0 && (
        <NotebookBlock tone="window" title="Window functions" step="windows" {...previewProps}>
          <div className="flex flex-wrap items-center gap-1.5">
            {wins.map((w) => (
              <Pill
                key={w.id}
                tone="window"
                label={windowPillLabel(w)}
                onRemove={() => removeWindow(w.id)}
                wide
                {...pillOpen(w.id)}
              >
                <WindowRow
                  win={w}
                  columns={windowCols}
                  onChange={(next) => updateWindow(w.id, next)}
                />
              </Pill>
            ))}
            <AddPill tone="window" onClick={addWindow} label="Add a window function" />
          </div>
        </NotebookBlock>
      )}

      {/* ── Sort ────────────────────────────────────────────────── */}
      {draft.sort.length > 0 && (
        <NotebookBlock tone="neutral" title="Sort" step="sort" {...previewProps}>
          <div className="flex flex-wrap items-center gap-1.5">
            {draft.sort.map((s) => (
              <Pill
                key={s.id}
                tone="neutral"
                label={sortPillLabel(s)}
                onRemove={() => removeSort(s.id)}
                {...pillOpen(s.id)}
              >
                <SortRow
                  sort={s}
                  columns={sortCols}
                  onChange={(next) => updateSort(s.id, next)}
                />
              </Pill>
            ))}
            <AddPill tone="neutral" onClick={addSort} label="Add a sort key" />
          </div>
        </NotebookBlock>
      )}

      {/* ── Row limit ───────────────────────────────────────────── */}
      <NotebookBlock tone="neutral" title="Row limit">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2">
            <span className="whitespace-nowrap text-xs text-muted-foreground">Limit</span>
            <Input
              type="number"
              min={1}
              max={1000}
              value={draft.limit}
              onChange={(e) => patch({ limit: Math.max(1, Number(e.target.value) || 1) })}
              className="h-7 w-24"
              aria-label="Row limit"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="whitespace-nowrap text-xs text-muted-foreground">Offset</span>
            <Input
              type="number"
              min={0}
              value={draft.offset}
              onChange={(e) => patch({ offset: Math.max(0, Number(e.target.value) || 0) })}
              className="h-7 w-24"
              aria-label="Row offset"
            />
          </label>
        </div>
      </NotebookBlock>

      {/* ── Action row — add hidden steps (Metabase style) ──────── */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <ActionButton
          tone="filter"
          icon={<FilterIcon className="h-3.5 w-3.5" />}
          label="Filter"
          onClick={addFilter}
        />
        <ActionButton
          tone="data"
          icon={<GitMerge className="h-3.5 w-3.5" />}
          label="Join data"
          onClick={addJoin}
        />
        <ActionButton
          tone="neutral"
          icon={<Calculator className="h-3.5 w-3.5" />}
          label="Custom column"
          onClick={addCalc}
        />
        {draft.metrics.length > 0 && (
          <ActionButton
            tone="summarize"
            icon={<ListFilter className="h-3.5 w-3.5" />}
            label="Metric filter"
            onClick={addHaving}
          />
        )}
        <ActionButton
          tone="window"
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          label="Window"
          onClick={addWindow}
        />
        <ActionButton
          tone="neutral"
          icon={<ArrowUpDown className="h-3.5 w-3.5" />}
          label="Sort"
          onClick={addSort}
        />
      </div>

      {/* ── Validation summary ──────────────────────────────────── */}
      {compiled.errors.length > 0 && (
        <ul
          className="w-full space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
          role="status"
        >
          {compiled.errors.map((err, i) => (
            <li key={i}>• {err}</li>
          ))}
        </ul>
      )}
    </div>
  );

  if (chromeless) {
    return <div className="h-full overflow-auto pr-1">{notebook}</div>;
  }

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Query builder</CardTitle>
          <Badge variant="muted">{datasetName}</Badge>
        </div>
        {onRun && (
          <Button size="xs" onClick={onRun} disabled={!canRun}>
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

      <CardContent className="overflow-auto pt-4">{notebook}</CardContent>
    </Card>
  );
}

// ── Notebook chrome ───────────────────────────────────────────────────────────

function NotebookBlock({
  tone,
  title,
  step,
  onPreviewStep,
  previewState,
  onClosePreview,
  children,
}: {
  tone: NbTone;
  title: string;
  /** Notebook step this block maps to — enables the per-step preview button. */
  step?: BuilderStep;
  onPreviewStep?: (step: BuilderStep) => void;
  previewState?: PreviewState | null;
  onClosePreview?: () => void;
  children: React.ReactNode;
}) {
  const showPreview = step !== undefined && previewState != null && previewState.step === step;
  return (
    <section className={cn("rounded-lg border p-3", NB[tone].block)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className={cn("text-sm font-semibold", NB[tone].title)}>{title}</h3>
        {step !== undefined && onPreviewStep && (
          <button
            type="button"
            onClick={() => onPreviewStep(step)}
            aria-label={`Preview ${title}`}
            title="Preview the first 10 rows as of this step"
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full transition-colors",
              NB[tone].preview,
            )}
          >
            <Play className="h-3 w-3 fill-current" />
          </button>
        )}
      </div>
      {children}
      {showPreview && onClosePreview && (
        <div className="mt-2">
          <PreviewPanel state={previewState} onClose={onClosePreview} />
        </div>
      )}
    </section>
  );
}

/**
 * A notebook pill: colored chip summarizing one item; click opens a popover
 * holding its full editor, × removes it. `wide` popovers host row-heavy
 * editors (joins/windows/filter groups).
 */
function Pill({
  tone,
  label,
  icon,
  mono = false,
  onRemove,
  wide = false,
  open,
  onOpenChange,
  children,
}: {
  tone: NbTone;
  label: string;
  icon?: React.ReactNode;
  mono?: boolean;
  onRemove?: () => void;
  wide?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <span
        className={cn(
          "inline-flex max-w-full items-stretch overflow-hidden rounded-md border text-xs font-medium shadow-sm transition-colors",
          NB[tone].pill,
        )}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 items-center gap-1.5 px-2.5 py-1"
            title={label}
          >
            {icon}
            <span className={cn("truncate", mono && "font-mono")}>{label}</span>
          </button>
        </PopoverTrigger>
        {onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenChange(false);
              onRemove();
            }}
            aria-label={`Remove ${label}`}
            className="flex items-center px-1.5 opacity-70 transition-opacity hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </span>
      <PopoverContent className={cn("w-auto", wide ? "max-w-[620px]" : "max-w-[480px]")}>
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** The "+" chip that appends an item to a block (and auto-opens its editor). */
function AddPill({ tone, onClick, label }: { tone: NbTone; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border transition-colors",
        NB[tone].soft,
      )}
    >
      <Plus className="h-3.5 w-3.5" />
    </button>
  );
}

/** Bottom action row button — reveals/extends a step (Metabase's step picker). */
function ActionButton({
  tone,
  icon,
  label,
  onClick,
}: {
  tone: NbTone;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
        NB[tone].soft,
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ── Filter tree (popover editors) ────────────────────────────────────────────

function ConnectorLabel({ label }: { label: string }) {
  return (
    <div className="pl-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {label}
    </div>
  );
}

function FilterNodeView({
  node,
  fields,
  byName,
  onChange,
  onRemove,
  onAddChild,
}: {
  node: DraftFilterNode;
  fields: Field[];
  byName: Map<string, Field>;
  onChange: (next: DraftFilterNode) => void;
  onRemove: () => void;
  onAddChild: (groupId: string, child: DraftFilterNode) => void;
}) {
  if (!isDraftGroup(node)) {
    return (
      <IrFilterRow
        filter={node}
        fields={fields}
        field={byName.get(node.column)}
        onChange={onChange}
        onRemove={onRemove}
      />
    );
  }
  return (
    <FilterGroupView
      group={node}
      fields={fields}
      byName={byName}
      onChange={onChange}
      onRemove={onRemove}
      onAddChild={onAddChild}
    />
  );
}

function FilterGroupView({
  group,
  fields,
  byName,
  onChange,
  onRemove,
  onAddChild,
}: {
  group: DraftFilterGroup;
  fields: Field[];
  byName: Map<string, Field>;
  onChange: (next: DraftFilterGroup) => void;
  /** Omitted at the top level — the pill's × already removes the group. */
  onRemove?: () => void;
  onAddChild: (groupId: string, child: DraftFilterNode) => void;
}) {
  const updateChild = (id: string, next: DraftFilterNode) =>
    onChange({ ...group, children: mapFilterNodes(group.children, id, () => next) });
  const removeChild = (id: string) =>
    onChange({ ...group, children: mapFilterNodes(group.children, id, () => null) });

  return (
    <div className="w-[540px] max-w-[85vw] space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={group.not ? "warning" : "outline"}
          size="xs"
          onClick={() => onChange({ ...group, not: !group.not })}
          aria-pressed={group.not}
          title="Negate this whole group"
        >
          NOT
        </Button>
        <Select
          value={group.op}
          onValueChange={(v) => onChange({ ...group, op: v as "and" | "or" })}
        >
          <SelectTrigger className="h-[26px] w-32 text-xs" aria-label="Group operator">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="or">Any match (OR)</SelectItem>
            <SelectItem value="and">All match (AND)</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="xs" onClick={() => onAddChild(group.id, newDraftFilter(fields[0]?.name ?? ""))}>
            <Plus className="h-3 w-3" />
            Condition
          </Button>
          <Button variant="ghost" size="xs" onClick={() => onAddChild(group.id, newDraftFilterGroup(group.op === "or" ? "and" : "or"))}>
            <Plus className="h-3 w-3" />
            Group
          </Button>
          {onRemove && <IconRemove onClick={onRemove} label="Remove group" />}
        </div>
      </div>

      <div className="space-y-2 border-l-2 border-border pl-3">
        {group.children.length === 0 ? (
          <p className="text-xs text-muted-foreground">Empty group — add a condition.</p>
        ) : (
          group.children.map((child, i) => (
            <React.Fragment key={child.id}>
              {i > 0 && <ConnectorLabel label={group.op} />}
              <FilterNodeView
                node={child}
                fields={fields}
                byName={byName}
                onChange={(next) => updateChild(child.id, next)}
                onRemove={() => removeChild(child.id)}
                onAddChild={onAddChild}
              />
            </React.Fragment>
          ))
        )}
      </div>
    </div>
  );
}

// ── Item editors (popover bodies) ────────────────────────────────────────────

function DimensionRow({
  dimension,
  fields,
  field,
  onChange,
}: {
  dimension: DraftDimension;
  fields: Field[];
  field: Field | undefined;
  onChange: (next: DraftDimension) => void;
}) {
  const isDate = field?.dataType === "date";
  const isNumber = field?.dataType === "number";
  return (
    <div className="flex w-[380px] max-w-[80vw] flex-wrap items-center gap-2">
      <Select
        value={dimension.column}
        onValueChange={(column) =>
          onChange({ ...dimension, column, temporal: undefined, bin: undefined })
        }
      >
        <SelectTrigger className="min-w-[120px] flex-1" aria-label="Dimension column">
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

      {isNumber && (
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          bin
          <Input
            type="number"
            min={0}
            value={dimension.bin ?? ""}
            onChange={(e) => onChange({ ...dimension, bin: e.target.value || undefined })}
            placeholder="size"
            className="w-20"
            aria-label="Bin size"
            title="Group into fixed-width numeric ranges (empty = exact value)"
          />
        </label>
      )}

      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        as
        <Input
          value={dimension.alias ?? ""}
          onChange={(e) => onChange({ ...dimension, alias: e.target.value || undefined })}
          placeholder="alias"
          className="w-28"
          aria-label="Dimension alias"
        />
      </label>
    </div>
  );
}

// Simple scalar/null operators offered for a conditional-aggregate predicate.
const METRIC_COND_OPS: IrFilterOp[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "starts_with",
  "ends_with",
  "is_null",
  "not_null",
];

function MetricRow({
  metric,
  fields,
  onChange,
}: {
  metric: DraftMetric;
  fields: Field[];
  onChange: (next: DraftMetric) => void;
}) {
  const needsColumn = aggNeedsColumn(metric.fn);
  const conditional = aggIsConditional(metric.fn);
  const takesFraction = aggTakesFraction(metric.fn);
  const cond = metric.cond ?? { column: fields[0]?.name ?? "", op: "gt" as IrFilterOp, value: "" };
  const condTakesValue = cond.op !== "is_null" && cond.op !== "not_null";
  const setCond = (next: Partial<DraftMetric["cond"] & object>) =>
    onChange({ ...metric, cond: { ...cond, ...next } });

  return (
    <div className="flex w-[440px] max-w-[85vw] flex-wrap items-center gap-2">
      <Select
        value={metric.fn}
        onValueChange={(v) => {
          const fn = v as AggFn;
          const next: DraftMetric = { ...metric, fn };
          // Seed a condition when switching to count_if / sum_if so the shown
          // state matches the persisted draft (the pill + compile read metric.cond).
          if (aggIsConditional(fn) && !next.cond) {
            next.cond = { column: fields[0]?.name ?? "", op: "gt", value: "" };
          }
          onChange(next);
        }}
      >
        <SelectTrigger className="w-44" aria-label="Aggregation">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ALL_IR_AGG_FNS.map((fn) => (
            <SelectItem key={fn} value={fn}>
              {AGG_PILL_LABELS[fn]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={metric.column}
        onValueChange={(column) => onChange({ ...metric, column })}
        disabled={!needsColumn}
      >
        <SelectTrigger className="min-w-[120px] flex-1" aria-label="Metric column">
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

      {takesFraction && (
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          P
          <Input
            type="number"
            min={1}
            max={99}
            value={metric.p ?? ""}
            onChange={(e) => onChange({ ...metric, p: e.target.value || undefined })}
            placeholder="90"
            className="w-20"
            aria-label="Percentile"
            title="Percentile 1–99 (e.g. 90 for the 90th percentile)"
          />
        </label>
      )}

      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        as
        <Input
          value={metric.alias ?? ""}
          onChange={(e) => onChange({ ...metric, alias: e.target.value || undefined })}
          placeholder="alias"
          className="w-28"
          aria-label="Metric alias"
        />
      </label>

      {conditional && (
        <div className="flex w-full flex-wrap items-center gap-2 border-t border-border pt-2">
          <span className="text-xs text-muted-foreground">where</span>
          <Select value={cond.column} onValueChange={(v) => setCond({ column: v })}>
            <SelectTrigger className="min-w-[110px] flex-1" aria-label="Condition column">
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
          <Select value={cond.op} onValueChange={(v) => setCond({ op: v as IrFilterOp })}>
            <SelectTrigger className="w-32" aria-label="Condition operator">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METRIC_COND_OPS.map((op) => (
                <SelectItem key={op} value={op}>
                  {IR_OPERATOR_LABELS[op]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {condTakesValue && (
            <Input
              value={cond.value}
              onChange={(e) => setCond({ value: e.target.value })}
              placeholder="value"
              className="w-28"
              aria-label="Condition value"
            />
          )}
        </div>
      )}
    </div>
  );
}

function HavingRow({
  having,
  metrics,
  onChange,
}: {
  having: DraftHaving;
  metrics: DraftMetric[];
  onChange: (next: DraftHaving) => void;
}) {
  return (
    <div className="flex w-[420px] max-w-[80vw] flex-wrap items-center gap-2">
      <Select
        value={having.metricIndex === null ? "" : String(having.metricIndex)}
        onValueChange={(v) => onChange({ ...having, metricIndex: Number(v) })}
      >
        <SelectTrigger className="min-w-[160px] flex-1" aria-label="Having metric">
          <SelectValue placeholder="Metric" />
        </SelectTrigger>
        <SelectContent>
          {metrics.map((m, i) => (
            <SelectItem key={m.id} value={String(i)}>
              {draftMetricAlias(m, i)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={having.op} onValueChange={(v) => onChange({ ...having, op: v as HavingOp })}>
        <SelectTrigger className="w-28" aria-label="Having operator">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {HAVING_OPS.map((op) => (
            <SelectItem key={op} value={op}>
              {HAVING_LABELS[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {having.op === "between" ? (
        <div className="flex items-center gap-1">
          <Input
            value={having.low}
            onChange={(e) => onChange({ ...having, low: e.target.value })}
            placeholder="min"
            className="w-24"
            aria-label="Having low"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <Input
            value={having.high}
            onChange={(e) => onChange({ ...having, high: e.target.value })}
            placeholder="max"
            className="w-24"
            aria-label="Having high"
          />
        </div>
      ) : (
        <Input
          type="number"
          value={having.value}
          onChange={(e) => onChange({ ...having, value: e.target.value })}
          placeholder="value"
          className="w-28"
          aria-label="Having value"
        />
      )}
    </div>
  );
}

function SortRow({
  sort,
  columns,
  onChange,
}: {
  sort: DraftSort;
  columns: string[];
  onChange: (next: DraftSort) => void;
}) {
  return (
    <div className="flex w-[360px] max-w-[80vw] flex-wrap items-center gap-2">
      <Select value={sort.column} onValueChange={(column) => onChange({ ...sort, column })}>
        <SelectTrigger className="min-w-[160px] flex-1" aria-label="Sort column">
          <SelectValue placeholder="Column" />
        </SelectTrigger>
        <SelectContent>
          {columns.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={sort.dir} onValueChange={(v) => onChange({ ...sort, dir: v as "asc" | "desc" })}>
        <SelectTrigger className="w-36" aria-label="Sort direction">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="desc">Highest first</SelectItem>
          <SelectItem value="asc">Lowest first</SelectItem>
        </SelectContent>
      </Select>
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
  /** Present only inside group editors — top-level pills remove via ×. */
  onRemove?: () => void;
}) {
  const ops = field ? irOperatorsFor(field.dataType) : (["eq"] as IrFilterOp[]);

  const onColumnChange = (column: string) => {
    const nextField = fields.find((f) => f.name === column);
    const nextOps = nextField ? irOperatorsFor(nextField.dataType) : ops;
    const op = nextOps.includes(filter.op) ? filter.op : nextOps[0];
    onChange({ ...filter, column, op });
  };

  return (
    <div className="flex w-full min-w-[320px] max-w-[80vw] flex-wrap items-center gap-2 sm:w-[440px]">
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

      {onRemove && <IconRemove onClick={onRemove} label="Remove filter" />}
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
      <div className="min-w-[140px] flex-1">
        <MultiValueInput
          values={filter.values}
          onChange={(values) => onChange({ ...filter, values })}
          aria-label="Values"
        />
      </div>
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
}: {
  join: DraftJoin;
  fields: Field[];
  onChange: (next: DraftJoin) => void;
}) {
  const updateCondition = (id: string, next: { left?: string; right?: string }) =>
    onChange({
      ...join,
      conditions: join.conditions.map((c) => (c.id === id ? { ...c, ...next } : c)),
    });
  const removeCondition = (id: string) =>
    onChange({ ...join, conditions: join.conditions.filter((c) => c.id !== id) });
  const addCondition = () =>
    onChange({ ...join, conditions: [...join.conditions, newDraftJoinCondition()] });

  return (
    <div className="w-[560px] max-w-[85vw] space-y-2">
      <div className="flex flex-wrap items-center gap-2">
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

        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          as
          <Input
            value={join.alias ?? ""}
            onChange={(e) => onChange({ ...join, alias: e.target.value || undefined })}
            placeholder={join.table || "alias"}
            className="w-28"
            aria-label="Join alias"
          />
        </label>

        <div className="ml-auto">
          <Button variant="ghost" size="xs" onClick={addCondition}>
            <Plus className="h-3 w-3" />
            Condition
          </Button>
        </div>
      </div>

      <div className="space-y-1.5 border-l-2 border-border pl-3">
        {join.conditions.map((c, i) => (
          <div key={c.id} className="flex flex-wrap items-center gap-2">
            <span className="w-7 text-right text-xs text-muted-foreground">
              {i === 0 ? "on" : "and"}
            </span>
            <Select value={c.left} onValueChange={(v) => updateCondition(c.id, { left: v })}>
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
              value={c.right}
              onChange={(e) => updateCondition(c.id, { right: e.target.value })}
              placeholder="joined column"
              className="w-40"
              aria-label="Joined column"
            />
            {join.conditions.length > 1 && (
              <IconRemove onClick={() => removeCondition(c.id)} label="Remove condition" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CalcRow({
  calc,
  fields,
  onChange,
}: {
  calc: DraftCalc;
  fields: Field[];
  onChange: (next: DraftCalc) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Bump on each insert so the "insert" Selects re-fire even when the same
  // option is picked twice (a remount resets their internal value).
  const [nonce, setNonce] = React.useState(0);

  const insert = (snippet: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? calc.text.length;
    const end = el?.selectionEnd ?? calc.text.length;
    const { text, caret } = spliceSnippet(calc.text, start, end, snippet);
    onChange({ ...calc, text });
    setNonce((n) => n + 1);
    // Restore focus + caret after React commits the new value.
    requestAnimationFrame(() => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      try {
        node.setSelectionRange(caret, caret);
      } catch {
        /* setSelectionRange unsupported on some input types — ignore */
      }
    });
  };

  // Live syntax validation (column existence is checked at compile time).
  const parsed = calc.text.trim() ? parseExprText(calc.text) : null;
  const error = parsed?.error ?? null;

  const PICK = "__pick";

  return (
    <div className="flex w-[520px] max-w-[85vw] flex-wrap items-center gap-2">
      <Input
        value={calc.name}
        onChange={(e) => onChange({ ...calc, name: e.target.value })}
        placeholder="name"
        className="w-32"
        aria-label="Calculated field name"
      />
      <span className="text-xs text-muted-foreground">=</span>
      <Input
        ref={inputRef}
        value={calc.text}
        onChange={(e) => onChange({ ...calc, text: e.target.value })}
        placeholder="[revenue] - [cost]"
        className={cn(
          "min-w-[200px] flex-1 font-mono text-xs",
          error && "border-destructive focus-visible:outline-destructive",
        )}
        aria-label="Formula"
        aria-invalid={error ? true : undefined}
        title={`Functions: ${EXPR_FNS.join(", ")} · case when … then … else … end`}
      />
      {/* Insert a column reference at the caret */}
      {fields.length > 0 && (
        <Select key={`col-${nonce}`} value={PICK} onValueChange={(v) => v !== PICK && insert(columnRef(v))}>
          <SelectTrigger className="h-8 w-[104px]" aria-label="Insert column">
            <SelectValue placeholder="＋ column" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PICK} disabled>
              ＋ column
            </SelectItem>
            {fields.map((f) => (
              <SelectItem key={f.name} value={f.name}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {/* Insert a function call at the caret */}
      <Select key={`fn-${nonce}`} value={PICK} onValueChange={(v) => v !== PICK && insert(`${v}(`)}>
        <SelectTrigger className="h-8 w-[92px]" aria-label="Insert function">
          <SelectValue placeholder="＋ fn" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={PICK} disabled>
            ＋ fn
          </SelectItem>
          {EXPR_FNS.map((fn) => (
            <SelectItem key={fn} value={fn}>
              {fn}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? (
        <p className="w-full text-[11px] text-destructive">{error}</p>
      ) : (
        <p className="w-full text-[11px] text-muted-foreground">
          Reference columns as <code className="font-mono">[name]</code>; e.g.{" "}
          <code className="font-mono">[revenue] - [cost]</code> or{" "}
          <code className="font-mono">case when [qty] &gt; 9 then &apos;big&apos; else &apos;small&apos; end</code>
        </p>
      )}
    </div>
  );
}

function WindowRow({
  win,
  columns,
  onChange,
}: {
  win: DraftWindow;
  columns: string[];
  onChange: (next: DraftWindow) => void;
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

  const updatePartition = (i: number, v: string) => {
    const partitions = [...win.partitions];
    if (v === "") partitions.splice(i, 1);
    else partitions[i] = v;
    onChange({ ...win, partitions });
  };
  const updateOrder = (id: string, next: Partial<DraftWindow["orders"][number]>) =>
    onChange({
      ...win,
      orders: win.orders.map((o) => (o.id === id ? { ...o, ...next } : o)),
    });
  const removeOrder = (id: string) =>
    onChange({ ...win, orders: win.orders.filter((o) => o.id !== id) });

  return (
    <div className="w-[560px] max-w-[85vw] space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={win.fn}
          onValueChange={(v) => onChange({ ...newDraftWindow(v as WindowFn), id: win.id, alias: win.alias })}
        >
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
      </div>

      {/* Partitions (multi) */}
      <div className="flex flex-wrap items-center gap-2 pl-3">
        <span className="text-xs text-muted-foreground">partition by</span>
        {win.partitions.map((p, i) => (
          <React.Fragment key={`${p}-${i}`}>
            {colSelect(p, (v) => updatePartition(i, v), `Partition ${i + 1}`, "(remove)")}
          </React.Fragment>
        ))}
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onChange({ ...win, partitions: [...win.partitions, columns[0] ?? ""] })}
          disabled={columns.length === 0}
        >
          <Plus className="h-3 w-3" />
          Column
        </Button>
      </div>

      {/* Order keys (multi) */}
      <div className="flex flex-wrap items-center gap-2 pl-3">
        <span className="text-xs text-muted-foreground">order by</span>
        {win.orders.map((o) => (
          <div key={o.id} className="flex items-center gap-1">
            {colSelect(o.column, (v) => (v === "" ? removeOrder(o.id) : updateOrder(o.id, { column: v })), "Order column", "(remove)")}
            <Select
              value={o.dir}
              onValueChange={(v) => updateOrder(o.id, { dir: v as "asc" | "desc" })}
            >
              <SelectTrigger className="w-20" aria-label="Order direction">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">Asc</SelectItem>
                <SelectItem value="desc">Desc</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ))}
        <Button
          variant="ghost"
          size="xs"
          onClick={() =>
            onChange({
              ...win,
              orders: [...win.orders, newDraftWindowOrder(columns[0] ?? "")],
            })
          }
          disabled={columns.length === 0}
        >
          <Plus className="h-3 w-3" />
          Key
        </Button>
      </div>
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

/** Raw-mode column chips: click to include/exclude; empty selection = all. */
function DataColumnPicker({
  fields,
  rawColumns,
  onChange,
}: {
  fields: Field[];
  rawColumns: string[];
  onChange: (rawColumns: string[]) => void;
}) {
  const all = fields.map((f) => f.name);
  const selected = rawColumns.length === 0 ? new Set(all) : new Set(rawColumns);

  const toggle = (name: string) => {
    const current = rawColumns.length === 0 ? all : rawColumns;
    const next = current.includes(name)
      ? current.filter((n) => n !== name)
      : [...current, name];
    if (next.length === 0) return; // keep at least one column selected
    onChange(next.length === all.length ? [] : next);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex max-h-48 flex-wrap gap-1 overflow-auto">
        {fields.map((f) => {
          const on = selected.has(f.name);
          return (
            <button
              key={f.name}
              type="button"
              onClick={() => toggle(f.name)}
              aria-pressed={on}
              className={cn(
                "rounded-md border px-2 py-0.5 text-xs transition-colors",
                on
                  ? "border-brand/40 bg-brand/15 text-brand-600 dark:text-brand-400"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {f.name}
            </button>
          );
        })}
      </div>
      {rawColumns.length > 0 && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => onChange([])}
        >
          Select all ({all.length})
        </button>
      )}
    </div>
  );
}

/** Inline 10-row result under a block — bounded page, closed on demand. */
function PreviewPanel({ state, onClose }: { state: PreviewState; onClose: () => void }) {
  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Step preview · first 10 rows
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={onClose}
          aria-label="Close preview"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      {state.status === "loading" ? (
        <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running…
        </div>
      ) : state.status === "error" ? (
        <p className="px-2 py-3 text-xs text-destructive">{state.error}</p>
      ) : (
        <div className="max-h-44 overflow-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr>
                {state.data.columns.map((c) => (
                  <th
                    key={c}
                    className="whitespace-nowrap border-b border-border px-2 py-1 text-left font-medium text-muted-foreground"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.data.rows.map((row, i) => (
                <tr key={i} className="border-b border-border/50 last:border-0">
                  {row.map((v, j) => (
                    <td key={j} className="whitespace-nowrap px-2 py-1 font-mono">
                      {v == null ? "∅" : String(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {state.data.rows.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">No rows.</p>
          )}
        </div>
      )}
    </div>
  );
}
