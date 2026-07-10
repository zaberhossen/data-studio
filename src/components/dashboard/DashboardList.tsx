"use client";

/**
 * DashboardList — the dashboard switcher (a compact dropdown in the toolbar).
 *
 * Lists the org's dashboards, marks the active one, and offers "New dashboard"
 * + "Delete". Purely presentational: all state + persistence live in
 * `useDashboardList`; this only renders + emits callbacks.
 */

import * as React from "react";
import { Check, ChevronDown, LayoutDashboard, Plus, Trash2 } from "lucide-react";
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

interface Props {
  list: DashboardSummary[];
  activeId: string | null;
  /** The active dashboard's live name (may be freshly renamed, unlike the list). */
  activeName: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}

export function DashboardList({ list, activeId, activeName, onSelect, onCreate, onDelete }: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 max-w-[220px] gap-1.5">
          <LayoutDashboard className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-medium">{activeName || "Dashboards"}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[16rem]">
        <DropdownMenuLabel>Dashboards</DropdownMenuLabel>
        {list.map((d) => (
          <DropdownMenuItem key={d.id} onSelect={() => onSelect(d.id)}>
            <Check
              className={d.id === activeId ? "opacity-100" : "opacity-0"}
            />
            <span className="flex-1 truncate">{d.id === activeId ? activeName || d.name : d.name}</span>
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
        <DropdownMenuItem onSelect={onCreate}>
          <Plus />
          New dashboard
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
