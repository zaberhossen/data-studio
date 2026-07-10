"use client";

/**
 * QueryBuilder — the visual report editor.
 *
 * Composes the engine-supported query surface:
 *   Dataset (display) → Filters (add/edit/remove) → GROUP BY dimension →
 *   Metric + Aggregation → Sort + Top-N limit.
 *
 * It owns a loose `QueryDraft` (string-typed, with UI ids), compiles it to the
 * strict engine `Query` on every change via `compileQuery`, and surfaces both:
 *   • onChange(draft, compile) — fires on every edit (for a live preview)
 *   • onRun(query)             — fires only when valid + the user runs it
 *
 * It NEVER touches raw rows — it only manipulates the small declarative query,
 * so all of this is safe React state. The compiled `Query` is the boundary the
 * parent hands to `useAnalyticsEngine().runQuery`.
 *
 * shadcn primitives: Card, Select, Input, Button, Badge; composes FilterRow +
 * MultiValueInput.
 * States handled: valid (Run enabled), invalid (errors listed, Run disabled),
 * COUNT (metric column disabled), running (Run shows busy), no-fields (guard).
 */

import * as React from "react";
import { Play, Plus } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  AGG_LABELS,
  ALL_AGG_FNS,
  compileQuery,
  emptyDraft,
  isDimension,
  isMetric,
  operatorsFor,
  type CompileResult,
  type DraftFilter,
  type Field,
  type QueryDraft,
} from "@/lib/query/schema";
import type { AggFn, Query, SortDir } from "@/lib/types/analytics";
import { FilterRow } from "./FilterRow";

interface QueryBuilderProps {
  /** Columns of the active dataset (dimensions + metrics). */
  fields: Field[];
  /** Display name of the active dataset (single source for now). */
  datasetName?: string;
  /**
   * Controlled draft. When provided, the builder is controlled and reports
   * edits via `onDraftChange` (lets a parent seed it from the SQL→Builder
   * bridge). When omitted, the builder owns its own draft state.
   */
  draft?: QueryDraft;
  /** Fires with the next draft when controlled. */
  onDraftChange?: (draft: QueryDraft) => void;
  /** Fires on every edit with the loose draft + its compile result. */
  onChange?: (draft: QueryDraft, compiled: CompileResult) => void;
  /** Fires when the user runs a valid query. */
  onRun?: (query: Query) => void;
  /** True while the engine is processing the last run. */
  running?: boolean;
}

export function QueryBuilder({
  fields,
  datasetName = "Sales dataset",
  draft: controlledDraft,
  onDraftChange,
  onChange,
  onRun,
  running = false,
}: QueryBuilderProps) {
  const dimensions = React.useMemo(() => fields.filter(isDimension), [fields]);
  const metrics = React.useMemo(() => fields.filter(isMetric), [fields]);

  const isControlled = controlledDraft !== undefined;
  const [internalDraft, setInternalDraft] = React.useState<QueryDraft>(() =>
    emptyDraft(fields),
  );
  const draft = isControlled ? controlledDraft : internalDraft;

  // Accepts either a next-draft or an updater, routing to the right owner.
  const setDraft = React.useCallback(
    (updater: QueryDraft | ((prev: QueryDraft) => QueryDraft)) => {
      const next =
        typeof updater === "function" ? updater(draft) : updater;
      if (isControlled) onDraftChange?.(next);
      else setInternalDraft(next);
    },
    [draft, isControlled, onDraftChange],
  );

  // Monotonic id source for new filter rows (no Date/Math.random needed).
  const filterSeq = React.useRef(0);

  const compiled = React.useMemo(
    () => compileQuery(draft, fields),
    [draft, fields],
  );

  // Surface every edit to the parent (for live preview / dirty tracking).
  React.useEffect(() => {
    onChange?.(draft, compiled);
  }, [draft, compiled, onChange]);

  const patch = (next: Partial<QueryDraft>) =>
    setDraft((d) => ({ ...d, ...next }));

  const addFilter = () => {
    const first = fields[0];
    if (!first) return;
    const newFilter: DraftFilter = {
      id: `f${++filterSeq.current}`,
      column: first.name,
      operator: operatorsFor(first.dataType)[0],
      value: "",
      values: [],
    };
    patch({ filters: [...draft.filters, newFilter] });
  };

  const updateFilter = (id: string, next: DraftFilter) =>
    patch({
      filters: draft.filters.map((f) => (f.id === id ? next : f)),
    });

  const removeFilter = (id: string) =>
    patch({ filters: draft.filters.filter((f) => f.id !== id) });

  const run = () => {
    if (compiled.query) onRun?.(compiled.query);
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

  const canRun = !!compiled.query && !running;

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Query</CardTitle>
          <Badge variant="muted">{datasetName}</Badge>
        </div>
        <Button size="sm" onClick={run} disabled={!canRun}>
          <Play className="h-3.5 w-3.5" />
          {running ? "Running…" : "Run"}
        </Button>
      </CardHeader>

      <CardContent className="flex-1 space-y-6 overflow-auto">
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
                <FilterRow
                  key={f.id}
                  filter={f}
                  fields={fields}
                  onChange={(next) => updateFilter(f.id, next)}
                  onRemove={() => removeFilter(f.id)}
                />
              ))}
            </div>
          )}
        </Section>

        {/* ── Group by ────────────────────────────────────────────── */}
        <Section title="Group by">
          <Select
            value={draft.groupBy}
            onValueChange={(groupBy) => patch({ groupBy })}
          >
            <SelectTrigger aria-label="Group by dimension">
              <SelectValue placeholder="Dimension" />
            </SelectTrigger>
            <SelectContent>
              {dimensions.map((f) => (
                <SelectItem key={f.name} value={f.name}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Section>

        {/* ── Metric + aggregation ────────────────────────────────── */}
        <Section title="Measure">
          <div className="flex gap-2">
            <Select
              value={draft.aggFn}
              onValueChange={(v) => patch({ aggFn: v as AggFn })}
            >
              <SelectTrigger className="w-32" aria-label="Aggregation">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_AGG_FNS.map((fn) => (
                  <SelectItem key={fn} value={fn}>
                    {AGG_LABELS[fn]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={draft.metricColumn}
              onValueChange={(metricColumn) => patch({ metricColumn })}
              disabled={draft.aggFn === "count"}
            >
              <SelectTrigger className="flex-1" aria-label="Metric column">
                <SelectValue
                  placeholder={
                    draft.aggFn === "count" ? "All rows" : "Metric column"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {metrics.map((f) => (
                  <SelectItem key={f.name} value={f.name}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {draft.aggFn === "count" && (
            <p className="mt-1 text-xs text-muted-foreground">
              COUNT tallies matching rows — no metric column needed.
            </p>
          )}
        </Section>

        {/* ── Sort + limit ────────────────────────────────────────── */}
        <Section title="Sort & limit">
          <div className="flex gap-2">
            <Select
              value={draft.sort}
              onValueChange={(v) => patch({ sort: v as SortDir })}
            >
              <SelectTrigger className="flex-1" aria-label="Sort direction">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desc">Highest first</SelectItem>
                <SelectItem value="asc">Lowest first</SelectItem>
              </SelectContent>
            </Select>

            <label className="flex items-center gap-2">
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                Top
              </span>
              <Input
                type="number"
                min={1}
                max={500}
                value={draft.limit}
                onChange={(e) =>
                  patch({
                    limit: Math.max(1, Number(e.target.value) || 1),
                  })
                }
                className="w-20"
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

/** Labeled section wrapper to keep the builder body consistent. */
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
