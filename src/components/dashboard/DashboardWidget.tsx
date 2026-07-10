"use client";

/**
 * DashboardWidget — a thin tile wrapper around the EXISTING chart/table views.
 *
 * A widget = header (title + menu) + a body that reuses `ResultsChart` /
 * `ResultsTable`, with its OWN loading / empty / error states. It never touches
 * raw rows: it subscribes to the scheduler for its normalized result
 * (`ChartPayload` for chart/kpi, `ResultTable` page for table) and renders that.
 *
 * Cross-filtering: clicking a bar/line data point emits a { column, value }
 * cross-filter via the filter context. The emitting widget is excluded from its
 * own cross-filter (loop guard in buildEffectiveWidget). Clicking a table cell
 * emits a cross-filter on that column too.
 *
 * Effective query: the scheduler receives an ephemeral effective widget (base ⊕
 * active filters ⊕ cross-filters). The base widget is NEVER mutated. The cache
 * key is derived from the effective query, so unaffected widgets hit the cache.
 */

import * as React from "react";
import {
  Copy,
  MoreVertical,
  Pencil,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ResultTable } from "@/lib/types/results";
import { formatCell } from "@/lib/results/format";
import { makeNumberFormatter, conditionalColor } from "@/lib/viz/format";
import type { Widget } from "@/lib/types/dashboard";
import { widgetCacheKey } from "@/lib/dashboard/hash";
import { buildEffectiveWidget } from "@/lib/dashboard/filters";
import {
  useWidgetResult,
  type QueryScheduler,
  type WidgetResult,
} from "@/hooks/useQueryScheduler";
import { ResultsTable } from "@/components/results/ResultsTable";
import { VizChart } from "@/components/results/VizChart";
import { PivotTable } from "@/components/results/PivotTable";
import { useFilterContext } from "./DashboardFilterContext";

interface DashboardWidgetProps {
  widget: Widget;
  scheduler: QueryScheduler;
  editable: boolean;
  onEdit: (widget: Widget) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
}

const NOOP = () => {};

export function DashboardWidget({
  widget,
  scheduler,
  editable,
  onEdit,
  onDuplicate,
  onRemove,
}: DashboardWidgetProps) {
  const { filterDefs, debouncedFilters, crossFilters, onCrossFilter } =
    useFilterContext();

  // Subscribe to the result BEFORE computing the effective widget so we have
  // the current result columns available for the SQL cross-filter skip check.
  const result = useWidgetResult(scheduler, widget.id);

  // Column names from the last cached result (null when no result yet).
  const resultColumns = React.useMemo(
    () => result.table?.columns.map((c) => c.name) ?? null,
    [result.table],
  );

  // Compute the ephemeral effective widget (never stored, never mutates base).
  const effectiveWidget = React.useMemo(
    () =>
      buildEffectiveWidget(
        widget,
        filterDefs,
        debouncedFilters,
        crossFilters,
        resultColumns,
      ),
    [widget, filterDefs, debouncedFilters, crossFilters, resultColumns],
  );

  // Re-submit when the effective cache key changes (filter on/off) or on mount.
  const effectiveCacheKey = widgetCacheKey(effectiveWidget);
  React.useEffect(() => {
    scheduler.submit(effectiveWidget);
    // widget.sourceId / widget.queryKind / effectiveCacheKey fully characterize
    // what should run; widget object identity changes on layout edits too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduler, widget.sourceId, widget.queryKind, effectiveCacheKey]);

  // Cross-filter emitter: widget.id is the source → loop guard in buildEffectiveWidget
  const handleCrossFilter = React.useCallback(
    (column: string, value: string | number) => {
      onCrossFilter(widget.id, column, value);
    },
    [widget.id, onCrossFilter],
  );

  // The group_by column for builder widgets (cross-filter x-axis label → this col).
  const builderGroupBy =
    widget.queryKind === "builder" ? (widget.query?.group_by ?? null) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground">
      <WidgetHeader
        widget={widget}
        editable={editable}
        loading={result.status === "loading"}
        onRefresh={() => scheduler.submit(effectiveWidget, true)}
        onEdit={() => onEdit(widget)}
        onDuplicate={() => onDuplicate(widget.id)}
        onRemove={() => onRemove(widget.id)}
      />
      <div className="min-h-0 flex-1 p-2">
        <WidgetBody
          widget={widget}
          result={result}
          builderGroupBy={builderGroupBy}
          onCrossFilter={handleCrossFilter}
        />
      </div>
    </div>
  );
}

function WidgetBody({
  widget,
  result,
  builderGroupBy,
  onCrossFilter,
}: {
  widget: Widget;
  result: WidgetResult;
  builderGroupBy: string | null;
  onCrossFilter: (column: string, value: string | number) => void;
}) {
  if (result.status === "loading" || result.status === "idle") {
    return <WidgetSkeleton viz={widget.viz.type} />;
  }
  if (result.status === "error") {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-3 text-center">
        <div className="max-w-xs">
          <TriangleAlert className="mx-auto h-5 w-5 text-destructive" />
          <p className="mt-1 text-xs font-medium text-destructive">Query failed</p>
          <p className="mt-0.5 line-clamp-3 text-[11px] text-destructive/80">
            {result.error}
          </p>
        </div>
      </div>
    );
  }
  if (result.status === "empty" || !result.table) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-3 text-center text-xs text-muted-foreground">
        No data for this widget.
      </div>
    );
  }

  const table = result.table;
  const groupBy = builderGroupBy ?? widget.viz.xKey ?? table.columns[0]?.name ?? null;
  switch (widget.viz.type) {
    case "kpi":
      return <KpiView table={table} widget={widget} />;
    case "table":
      return <TableView table={table} viz={widget.viz} onCrossFilter={onCrossFilter} />;
    case "pivot":
      return <PivotTable table={table} viz={widget.viz} />;
    default:
      return (
        <VizChart
          table={table}
          viz={widget.viz}
          onCategoryClick={groupBy ? (v) => onCrossFilter(groupBy, v) : undefined}
        />
      );
  }
}

/**
 * Single headline metric — first row's chosen (or first numeric) column. Honors
 * the widget's number format, an optional goal (progress vs. target), a trend
 * delta vs. the previous row, and conditional coloring of the value.
 */
function KpiView({ table, widget }: { table: ResultTable; widget: Widget }) {
  const { viz } = widget;
  const cols = table.columns;
  const yIdx = viz.yKey
    ? cols.findIndex((c) => c.name === viz.yKey)
    : cols.findIndex((c) => c.type === "number");
  const yi = yIdx >= 0 ? yIdx : cols.length - 1;
  const raw = table.rows[0]?.[yi];
  const fmt = React.useMemo(
    () => (viz.numberFormat ? makeNumberFormatter(viz.numberFormat) : null),
    [viz.numberFormat],
  );
  const display =
    raw == null
      ? "—"
      : fmt
        ? fmt(raw)
        : formatCell(raw, cols[yi]?.type ?? "number");

  const numeric = typeof raw === "number" ? raw : Number(raw);
  const color = conditionalColor(raw, viz.conditional, cols[yi]?.name);

  // Trend delta vs. the previous data row (when requested + available).
  const prev = viz.showTrend ? Number(table.rows[1]?.[yi]) : NaN;
  const delta =
    viz.showTrend && Number.isFinite(numeric) && Number.isFinite(prev) && prev !== 0
      ? (numeric - prev) / Math.abs(prev)
      : null;

  const goalPct =
    viz.goal && viz.goal !== 0 && Number.isFinite(numeric)
      ? Math.max(0, Math.min(1, numeric / viz.goal))
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center p-3 text-center">
      <div
        className="text-3xl font-semibold tabular-nums tracking-tight"
        style={color ? { color } : undefined}
      >
        {display}
        {viz.unit ? <span className="ml-1 text-lg text-muted-foreground">{viz.unit}</span> : null}
      </div>
      <div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">
        {cols[yi]?.name ?? "value"}
      </div>
      {delta != null && (
        <div
          className="mt-1 text-xs font-medium tabular-nums"
          style={{ color: delta >= 0 ? "var(--viz-good)" : "var(--viz-critical)" }}
        >
          {delta >= 0 ? "▲" : "▼"} {Math.abs(delta * 100).toFixed(1)}%
        </div>
      )}
      {goalPct != null && (
        <div className="mt-2 w-3/4 max-w-[180px]">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full" style={{ width: `${goalPct * 100}%`, background: "var(--viz-1)" }} />
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {Math.round(goalPct * 100)}% of goal
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Table view with click-to-cross-filter on cells + optional conditional
 * formatting (cell background tint when a rule matches).
 */
function TableView({
  table,
  viz,
  onCrossFilter,
}: {
  table: ResultTable;
  viz: Widget["viz"];
  onCrossFilter: (column: string, value: string | number) => void;
}) {
  const page: ResultTable = {
    ...table,
    totalRows: table.rows.length,
    capped: table.totalRows > table.rows.length,
  };

  const handleCellClick = React.useCallback(
    (rowIndex: number, colIndex: number) => {
      const col = table.columns[colIndex];
      const raw = table.rows[rowIndex]?.[colIndex];
      if (!col || raw == null) return;
      if (typeof raw === "string" || typeof raw === "number") {
        onCrossFilter(col.name, raw);
      }
    },
    [table, onCrossFilter],
  );

  const rules = viz.conditional;
  const cellColor = React.useMemo(
    () =>
      rules && rules.length > 0
        ? (_r: number, colIndex: number, value: unknown) =>
            conditionalColor(value, rules, table.columns[colIndex]?.name)
        : undefined,
    [rules, table.columns],
  );

  return (
    <ResultsTable
      status="data"
      table={page}
      sort={null}
      onPageChange={NOOP}
      onPageSizeChange={NOOP}
      onSort={NOOP}
      onExportCsv={NOOP}
      onCellClick={handleCellClick}
      cellColor={cellColor}
    />
  );
}

function WidgetSkeleton({ viz }: { viz: Widget["viz"]["type"] }) {
  if (viz === "kpi") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <div className="h-8 w-24 animate-pulse rounded bg-muted" />
        <div className="h-3 w-16 animate-pulse rounded bg-muted" />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col justify-end gap-1.5 p-3">
      {[60, 80, 45, 90, 70, 55].map((h, i) => (
        <div
          key={i}
          className="animate-pulse rounded bg-muted"
          style={{ height: `${h / 6}%`, width: "100%" }}
        />
      ))}
    </div>
  );
}

// ── Header + menu ────────────────────────────────────────────────────────────

function WidgetHeader({
  widget,
  editable,
  loading,
  onRefresh,
  onEdit,
  onDuplicate,
  onRemove,
}: {
  widget: Widget;
  editable: boolean;
  loading: boolean;
  onRefresh: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 border-b border-border px-3 py-2",
        editable && "widget-drag-handle cursor-move",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">{widget.title}</span>
        <span className="hidden shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground sm:inline">
          {widget.viz.type}
        </span>
      </div>

      <div className="relative flex shrink-0 items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Refresh widget"
          title="Refresh"
          disabled={loading}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onRefresh}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>

        {editable && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Widget menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </Button>
        )}

        {menuOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onMouseDown={() => setMenuOpen(false)}
            />
            <div
              role="menu"
              className="absolute right-0 top-8 z-50 w-40 overflow-hidden rounded-md border border-border bg-popover p-1 shadow-md"
            >
              <MenuItem
                icon={<Pencil className="h-3.5 w-3.5" />}
                onClick={() => { setMenuOpen(false); onEdit(); }}
              >
                Edit
              </MenuItem>
              <MenuItem
                icon={<Copy className="h-3.5 w-3.5" />}
                onClick={() => { setMenuOpen(false); onDuplicate(); }}
              >
                Duplicate
              </MenuItem>
              <MenuItem
                icon={<RefreshCw className="h-3.5 w-3.5" />}
                onClick={() => { setMenuOpen(false); onRefresh(); }}
              >
                Refresh
              </MenuItem>
              <MenuItem
                icon={<Trash2 className="h-3.5 w-3.5" />}
                destructive
                onClick={() => { setMenuOpen(false); setConfirmOpen(true); }}
              >
                Remove
              </MenuItem>
            </div>
          </>
        )}
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove widget?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            &quot;{widget.title}&quot; will be removed from this dashboard. This
            can&apos;t be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              className="border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={() => { setConfirmOpen(false); onRemove(); }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MenuItem({
  icon,
  children,
  onClick,
  destructive,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
        destructive && "text-destructive hover:bg-destructive/10",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
