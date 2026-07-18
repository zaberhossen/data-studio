"use client";

/**
 * ResultsTable — PRESENTATIONAL, decoupled results grid.
 *
 * It is fed ONE normalized `ResultTable` (current page only) and a set of
 * callbacks. It does NOT know whether the data came from the builder or SQL, it
 * has NO access to the raw dataset, and it NEVER sorts or paginates across
 * pages itself — every page/size/sort change is emitted to the parent, which
 * re-queries (SQL) or re-slices the in-hand payload (builder).
 *
 * @tanstack/react-table models the columns (headless); shadcn Table renders.
 * States: loading (skeleton), empty, error, data, capped (non-blocking note).
 */

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronsLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  Download,
  Loader2,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ResultColumnType, ResultTable, SortSpec } from "@/lib/types/results";
import { NULL_TOKEN, alignFor, formatCell, isNullish } from "@/lib/results/format";

export type ResultsStatus = "loading" | "empty" | "error" | "data";

const PAGE_SIZES = [25, 50, 100, 250];

interface ResultsTableProps {
  status: ResultsStatus;
  table: ResultTable | null;
  error?: string | null;
  /** Active sort, shown as the header indicator (controlled by the parent). */
  sort: SortSpec | null;
  /** True while a full-result CSV export is in flight. */
  exporting?: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onSort: (sort: SortSpec | null) => void;
  onExportCsv: () => void;
  /** Optional: called when a data cell is clicked (rowIndex, colIndex within current page). */
  onCellClick?: (rowIndex: number, colIndex: number) => void;
  /** Optional conditional formatting: a CSS color for a cell, or null for none. */
  cellColor?: (rowIndex: number, colIndex: number, value: unknown) => string | null;
  /**
   * Drill-through: actions for a column header's ⌄ menu. Empty array → no menu
   * on that column.
   */
  headerMenu?: (column: string) => DrillMenuItem[];
  /**
   * Drill-through: actions when a data cell is clicked (takes precedence over
   * `onCellClick`). Empty array → plain cell.
   */
  cellMenu?: (rowIndex: number, colIndex: number) => DrillMenuItem[];
}

export interface DrillMenuItem {
  label: string;
  onSelect: () => void;
}

/** Each data row is a positional tuple matching `columns`. */
type RowTuple = unknown[];

export function ResultsTable({
  status,
  table,
  error,
  sort,
  exporting = false,
  onPageChange,
  onPageSizeChange,
  onSort,
  onExportCsv,
  onCellClick,
  cellColor,
  headerMenu,
  cellMenu,
}: ResultsTableProps) {
  // One floating drill menu for headers + cells (fixed-positioned at the click).
  const [menu, setMenu] = React.useState<{
    x: number;
    y: number;
    items: DrillMenuItem[];
  } | null>(null);
  const openMenu = (e: React.MouseEvent, items: DrillMenuItem[]) => {
    if (items.length === 0) return;
    setMenu({
      x: Math.min(e.clientX, (typeof window !== "undefined" ? window.innerWidth : 1200) - 240),
      y: Math.min(e.clientY, (typeof window !== "undefined" ? window.innerHeight : 800) - 40 * items.length - 16),
      items,
    });
  };
  const columns = React.useMemo<ColumnDef<RowTuple>[]>(
    () =>
      (table?.columns ?? []).map((col, i) => ({
        id: col.name,
        accessorFn: (row) => row[i],
        header: col.name,
        meta: { type: col.type },
      })),
    [table],
  );

  const data = table?.rows ?? [];

  // eslint-disable-next-line react-hooks/incompatible-library -- @tanstack/react-table returns non-memoizable functions
  const rt = useReactTable({
    data: data as RowTuple[],
    columns,
    getCoreRowModel: getCoreRowModel(),
    // Pagination + sorting are SERVER/parent-driven — never client-side.
    manualPagination: true,
    manualSorting: true,
  });

  // Header click cycles: unsorted → asc → desc → unsorted.
  const cycleSort = (col: string) => {
    if (!sort || sort.column !== col) onSort({ column: col, dir: "asc" });
    else if (sort.dir === "asc") onSort({ column: col, dir: "desc" });
    else onSort(null);
  };

  const colCount = Math.max(columns.length, 1);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border border-border bg-card text-card-foreground">
      {/* Capped note (non-blocking) */}
      {table?.capped && status === "data" && (
        <p className="border-b border-border bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          Showing the first {table.totalRows.toLocaleString()} rows — the row cap
          was reached.
        </p>
      )}

      {/* Body region */}
      <div className="relative min-h-0 flex-1 overflow-auto">
        {status === "error" ? (
          <ErrorState message={error} />
        ) : status === "empty" ? (
          <EmptyState />
        ) : (
          <Table className="text-xs">
            <TableHeader className="sticky top-0 z-10 bg-surface-100">
              {rt.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="hover:bg-transparent">
                  {hg.headers.map((header) => {
                    const type = (header.column.columnDef.meta as
                      | { type: ResultColumnType }
                      | undefined)?.type;
                    const active = sort?.column === header.column.id;
                    return (
                      <TableHead
                        key={header.id}
                        aria-sort={
                          active
                            ? sort!.dir === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                        className={type === "number" ? "text-right" : "text-left"}
                      >
                        <span
                          className={cn(
                            "group/head inline-flex items-center gap-0.5",
                            type === "number" && "flex-row-reverse",
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => cycleSort(header.column.id)}
                            className={cn(
                              "inline-flex items-center gap-1 rounded px-1 -mx-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                              type === "number" && "flex-row-reverse",
                              active && "text-foreground",
                            )}
                          >
                            {flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                            {active &&
                              (sort!.dir === "asc" ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              ))}
                          </button>
                          {headerMenu && headerMenu(header.column.id).length > 0 && (
                            <button
                              type="button"
                              onClick={(e) => openMenu(e, headerMenu(header.column.id))}
                              aria-label={`Column actions for ${header.column.id}`}
                              className="rounded p-0.5 text-muted-foreground/50 hover:bg-surface-300 hover:text-foreground group-hover/head:text-muted-foreground"
                            >
                              <ChevronDown className="h-3 w-3" />
                            </button>
                          )}
                        </span>
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>

            <TableBody>
              {status === "loading"
                ? Array.from({ length: 8 }).map((_, r) => (
                    <TableRow key={r} className="hover:bg-transparent">
                      {Array.from({ length: colCount }).map((__, c) => (
                        <TableCell key={c}>
                          <div className="h-3.5 w-full max-w-[140px] animate-pulse rounded bg-muted" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                : rt.getRowModel().rows.map((row, rowIdx) => (
                    <TableRow key={row.id}>
                      {row.getVisibleCells().map((cell, colIdx) => {
                        const type = (cell.column.columnDef.meta as
                          | { type: ResultColumnType }
                          | undefined)?.type ?? "string";
                        const value = cell.getValue();
                        const cc = cellColor?.(rowIdx, colIdx, value) ?? null;
                        return (
                          <TableCell
                            key={cell.id}
                            className={cn(
                              "font-mono",
                              alignFor(type) === "right" ? "text-right" : "text-left",
                              (cellMenu || (onCellClick && !isNullish(value))) &&
                                "cursor-pointer hover:bg-primary/5",
                            )}
                            style={cc ? { color: cc, fontWeight: 500 } : undefined}
                            onClick={
                              cellMenu
                                ? (e) => openMenu(e, cellMenu(rowIdx, colIdx))
                                : onCellClick && !isNullish(value)
                                  ? () => onCellClick(rowIdx, colIdx)
                                  : undefined
                            }
                          >
                            {isNullish(value) ? (
                              <span className="italic text-muted-foreground/60">
                                {NULL_TOKEN}
                              </span>
                            ) : (
                              formatCell(value, type)
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
        )}
      </div>

      <StatusBar
        table={table}
        status={status}
        exporting={exporting}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
        onExportCsv={onExportCsv}
      />

      {/* Floating drill menu (headers + cells) — closes on any outside click. */}
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} aria-hidden />
          <div
            role="menu"
            className="fixed z-50 min-w-[200px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
            style={{ left: menu.x, top: menu.y }}
          >
            {menu.items.map((item, i) => (
              <button
                key={i}
                type="button"
                role="menuitem"
                className="block w-full rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
                onClick={() => {
                  setMenu(null);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function StatusBar({
  table,
  status,
  exporting,
  onPageChange,
  onPageSizeChange,
  onExportCsv,
}: {
  table: ResultTable | null;
  status: ResultsStatus;
  exporting: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onExportCsv: () => void;
}) {
  const total = table?.totalRows ?? 0;
  const pageSize = table?.pageSize || PAGE_SIZES[1];
  const page = table?.page ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / Math.max(pageSize, 1)));
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min(total, page * pageSize + (table?.rows.length ?? 0));
  const canExport = status === "data" && total > 0;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-3">
        <span>
          {total === 0
            ? "0 rows"
            : `Rows ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`}
        </span>
        {typeof table?.elapsedMs === "number" && (
          <span className="hidden sm:inline">· {table.elapsedMs.toFixed(1)} ms</span>
        )}
        {table && (
          <span className="hidden rounded bg-muted px-1.5 py-0.5 md:inline">
            {table.source === "builder" ? "builder" : "SQL"}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7"
          onClick={onExportCsv}
          disabled={!canExport || exporting}
        >
          {exporting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          Export CSV
        </Button>

        <label className="flex items-center gap-1.5">
          <span className="sr-only">Rows per page</span>
          <Select
            value={String(pageSize)}
            onValueChange={(v) => onPageSizeChange(Number(v))}
          >
            <SelectTrigger className="h-7 w-[88px]" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s} / page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <div className="flex items-center gap-0.5">
          <PagerButton
            label="First page"
            onClick={() => onPageChange(0)}
            disabled={page <= 0}
          >
            <ChevronsLeft className="h-4 w-4" />
          </PagerButton>
          <PagerButton
            label="Previous page"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 0}
          >
            <ChevronLeft className="h-4 w-4" />
          </PagerButton>
          <span className="px-1.5 tabular-nums">
            {page + 1} / {pageCount}
          </span>
          <PagerButton
            label="Next page"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pageCount - 1}
          >
            <ChevronRight className="h-4 w-4" />
          </PagerButton>
          <PagerButton
            label="Last page"
            onClick={() => onPageChange(pageCount - 1)}
            disabled={page >= pageCount - 1}
          >
            <ChevronsRight className="h-4 w-4" />
          </PagerButton>
        </div>
      </div>
    </div>
  );
}

function PagerButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </Button>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center p-6 text-center">
      <div>
        <p className="text-sm font-medium">No rows</p>
        <p className="text-xs text-muted-foreground">
          The query ran successfully but returned 0 rows.
        </p>
      </div>
    </div>
  );
}

function ErrorState({ message }: { message?: string | null }) {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center p-6">
      <div className="max-w-md rounded-md border border-destructive/40 bg-destructive/5 p-4 text-center">
        <p className="text-sm font-medium text-destructive">Query failed</p>
        <p className="mt-1 whitespace-pre-wrap text-xs text-destructive/90">
          {message ?? "Something went wrong running the query."}
        </p>
      </div>
    </div>
  );
}
