"use client";

/**
 * DashboardList — the dashboard switcher (a compact dropdown in the toolbar).
 *
 * Lists the org's dashboards with their TYPE (Page = grid, Canvas = free-form),
 * marks the active one, and offers per-row Duplicate/Delete plus "New dashboard"
 * (which opens the create dialog: name + Page/Canvas choice). Purely
 * presentational: all state + persistence live in `useDashboardList`.
 */

import * as React from "react";
import { Check, ChevronDown, Copy, LayoutGrid, PenTool, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DashboardSummary } from "@/hooks/useDashboardList";
import type { LayoutMode } from "@/lib/types/dashboard";
import { CreateDashboardDialog } from "./CreateDashboardDialog";

interface Props {
  list: DashboardSummary[];
  activeId: string | null;
  /** The active dashboard's live name (may be freshly renamed, unlike the list). */
  activeName: string;
  onSelect: (id: string) => void;
  onCreate: (input: { name: string; layoutMode: LayoutMode }) => Promise<void>;
  onDuplicate: (id: string) => Promise<void>;
  onDelete: (id: string) => void;
}

function TypeIcon({ mode }: { mode?: LayoutMode }) {
  const Icon = mode === "canvas" ? PenTool : LayoutGrid;
  return <Icon className="h-3.5 w-3.5 shrink-0 opacity-60" />;
}

export function DashboardList({
  list,
  activeId,
  activeName,
  onSelect,
  onCreate,
  onDuplicate,
  onDelete,
}: Props) {
  const [createOpen, setCreateOpen] = React.useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 max-w-[220px] gap-1.5">
            <TypeIcon mode={list.find((d) => d.id === activeId)?.layoutMode} />
            <span className="truncate font-medium">{activeName || "Dashboards"}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[18rem]">
          <DropdownMenuLabel>Dashboards</DropdownMenuLabel>
          {list.map((d) => (
            <DropdownMenuItem key={d.id} onSelect={() => onSelect(d.id)}>
              <Check className={d.id === activeId ? "opacity-100" : "opacity-0"} />
              <TypeIcon mode={d.layoutMode} />
              <span className="flex-1 truncate">
                {d.id === activeId ? activeName || d.name : d.name}
              </span>
              <Copy
                role="button"
                aria-label={`Duplicate ${d.name}`}
                className="opacity-50 hover:opacity-100"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void onDuplicate(d.id);
                }}
              />
              {list.length > 1 && (
                <Trash2
                  role="button"
                  aria-label={`Delete ${d.name}`}
                  className="opacity-50 hover:opacity-100"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDelete(d.id);
                  }}
                />
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
            <Plus />
            New dashboard
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateDashboardDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={onCreate} />
    </>
  );
}
