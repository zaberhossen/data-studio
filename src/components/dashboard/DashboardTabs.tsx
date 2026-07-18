"use client";

/**
 * DashboardTabs — the Page-view tab bar (Metabase-style, grid mode only).
 *
 * View mode: plain clickable tabs (hidden entirely when the dashboard has none).
 * Edit mode: double-click a tab to rename, hover for a remove ✕, and a trailing
 * "+" adds a tab. Removing a tab deletes its cards (undoable via ⌘Z).
 */

import * as React from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DashboardTab } from "@/lib/types/dashboard";

interface Props {
  tabs: DashboardTab[] | undefined;
  activeTabId: string | null;
  editable: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
}

export function DashboardTabs({
  tabs,
  activeTabId,
  editable,
  onSelect,
  onAdd,
  onRename,
  onRemove,
}: Props) {
  const list = tabs ?? [];
  // Nothing to show: no tabs and not editing (edit mode still offers "+").
  if (list.length === 0 && !editable) return null;

  return (
    <div className="flex items-center gap-0.5 border-b border-border px-3">
      {list.map((t) => (
        <TabButton
          key={t.id}
          tab={t}
          active={t.id === activeTabId}
          editable={editable}
          canRemove={list.length > 1}
          onSelect={() => onSelect(t.id)}
          onRename={(name) => onRename(t.id, name)}
          onRemove={() => onRemove(t.id)}
        />
      ))}
      {editable && (
        <button
          type="button"
          className="ml-1 flex items-center gap-1 rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onAdd}
          title={list.length === 0 ? "Split into tabs" : "Add tab"}
        >
          <Plus className="h-3.5 w-3.5" />
          {list.length === 0 ? "Add tabs" : "Tab"}
        </button>
      )}
    </div>
  );
}

function TabButton({
  tab,
  active,
  editable,
  canRemove,
  onSelect,
  onRename,
  onRemove,
}: {
  tab: DashboardTab;
  active: boolean;
  editable: boolean;
  canRemove: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [renaming, setRenaming] = React.useState(false);

  if (renaming) {
    return (
      <input
        defaultValue={tab.name}
        autoFocus
        aria-label="Tab name"
        className="my-1 w-28 rounded border border-strong bg-surface-100 px-1.5 py-1 text-xs outline-none"
        onBlur={(e) => {
          setRenaming(false);
          const next = e.target.value.trim();
          if (next && next !== tab.name) onRename(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
        }}
      />
    );
  }

  return (
    <div
      className={cn(
        "group relative -mb-px flex items-center gap-1 border-b-2 px-2.5 py-2 text-xs font-medium transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => editable && setRenaming(true)}
        title={editable ? "Click to open · double-click to rename" : tab.name}
      >
        {tab.name}
      </button>
      {editable && canRemove && (
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          aria-label={`Remove ${tab.name}`}
          title="Remove tab (and its cards)"
          onClick={onRemove}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
