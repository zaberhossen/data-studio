"use client";

/**
 * CanvasLayersPanel — the right-hand layers list for canvas mode (Figma-style).
 *
 * Lists every canvas item — decoration elements + query widgets sorted by
 * z-order (top-most first), then frames (artboards, the background layer) — and
 * lets you select (click / shift-click), rename (double-click), and toggle
 * lock / visibility per item. Selection is two-way bound to the stage.
 */

import * as React from "react";
import {
  BarChart3,
  Eye,
  EyeOff,
  Frame as FrameIcon,
  Group as GroupIcon,
  Image as ImageIcon,
  Lock,
  Minus,
  Square,
  Type,
  Unlock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasElement, CanvasFrame, Widget } from "@/lib/types/dashboard";

interface LayerRow {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  z: number;
  locked: boolean;
  hidden: boolean;
  /** Frames + text elements can be renamed inline; other kinds show a fixed label. */
  renamable: boolean;
  /** Persisted group membership (shows a group badge in the row). */
  groupId?: string;
}

interface Props {
  widgets: Widget[];
  elements: CanvasElement[];
  frames: CanvasFrame[];
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  onToggleLock: (id: string, locked: boolean) => void;
  onToggleHidden: (id: string, hidden: boolean) => void;
  /** Rename a frame (its `name`) or a widget (its `title`). */
  onRename: (id: string, name: string) => void;
}

const ELEMENT_ICON = {
  text: Type,
  image: ImageIcon,
  shape: Square,
  line: Minus,
} as const;

export function CanvasLayersPanel({
  widgets,
  elements,
  frames,
  selectedIds,
  onSelect,
  onToggleLock,
  onToggleHidden,
  onRename,
}: Props) {
  // Items (widgets + elements), top-most z first.
  const itemRows = React.useMemo<LayerRow[]>(() => {
    const rows: LayerRow[] = [
      ...widgets.map((w) => ({
        id: w.id,
        label: w.title || "Chart",
        icon: BarChart3,
        z: w.canvasLayout?.zIndex ?? 1,
        locked: !!w.canvasLayout?.locked,
        hidden: !!w.canvasLayout?.hidden,
        renamable: true,
        groupId: w.canvasLayout?.groupId,
      })),
      ...elements.map((e) => ({
        id: e.id,
        label:
          e.content.kind === "text"
            ? e.content.text.trim() || "Text"
            : e.content.kind[0].toUpperCase() + e.content.kind.slice(1),
        icon: ELEMENT_ICON[e.content.kind],
        z: e.canvasLayout.zIndex ?? 1,
        locked: !!e.canvasLayout.locked,
        hidden: !!e.canvasLayout.hidden,
        renamable: false,
        groupId: e.canvasLayout.groupId,
      })),
    ];
    return rows.sort((a, b) => b.z - a.z);
  }, [widgets, elements]);

  const frameRows = React.useMemo<LayerRow[]>(
    () =>
      frames.map((f) => ({
        id: f.id,
        label: f.name,
        icon: FrameIcon,
        z: 0,
        locked: !!f.locked,
        hidden: !!f.hidden,
        renamable: true,
      })),
    [frames],
  );

  return (
    <div className="flex h-full w-56 shrink-0 flex-col border-l border-border bg-card">
      <div className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Layers
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {itemRows.length === 0 && frameRows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">Nothing on the canvas yet.</p>
        ) : (
          <>
            {itemRows.map((row) => (
              <LayerRowView
                key={row.id}
                row={row}
                selected={selectedIds.includes(row.id)}
                onSelect={onSelect}
                selectedIds={selectedIds}
                onToggleLock={onToggleLock}
                onToggleHidden={onToggleHidden}
                onRename={onRename}
              />
            ))}
            {frameRows.length > 0 && (
              <div className="mt-1 border-t border-border pt-1">
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  Frames
                </div>
                {frameRows.map((row) => (
                  <LayerRowView
                    key={row.id}
                    row={row}
                    selected={selectedIds.includes(row.id)}
                    onSelect={onSelect}
                    selectedIds={selectedIds}
                    onToggleLock={onToggleLock}
                    onToggleHidden={onToggleHidden}
                    onRename={onRename}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function LayerRowView({
  row,
  selected,
  selectedIds,
  onSelect,
  onToggleLock,
  onToggleHidden,
  onRename,
}: {
  row: LayerRow;
  selected: boolean;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  onToggleLock: (id: string, locked: boolean) => void;
  onToggleHidden: (id: string, hidden: boolean) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [renaming, setRenaming] = React.useState(false);

  const click = (e: React.MouseEvent) => {
    if (e.shiftKey) {
      onSelect(
        selected ? selectedIds.filter((id) => id !== row.id) : [...selectedIds, row.id],
      );
    } else {
      onSelect([row.id]);
    }
  };

  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 px-2 py-1 text-xs transition-colors",
        selected ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent",
        row.hidden && "opacity-50",
      )}
    >
      <row.icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
      {renaming && row.renamable ? (
        <input
          defaultValue={row.label}
          autoFocus
          aria-label="Layer name"
          className="min-w-0 flex-1 rounded border border-strong bg-surface-100 px-1 outline-none"
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            setRenaming(false);
            const next = e.target.value.trim();
            if (next && next !== row.label) onRename(row.id, next);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
        />
      ) : (
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left"
          onClick={click}
          onDoubleClick={() => row.renamable && setRenaming(true)}
          title={row.label}
        >
          {row.label}
        </button>
      )}
      {row.groupId && (
        <GroupIcon
          className="h-3 w-3 shrink-0 opacity-50"
          aria-label="Grouped"
        />
      )}
      <button
        type="button"
        className={cn(
          "shrink-0 rounded p-0.5 hover:text-foreground",
          row.hidden ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
        aria-label={row.hidden ? "Show" : "Hide"}
        title={row.hidden ? "Show" : "Hide"}
        onClick={() => onToggleHidden(row.id, !row.hidden)}
      >
        {row.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        className={cn(
          "shrink-0 rounded p-0.5 hover:text-foreground",
          row.locked ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
        aria-label={row.locked ? "Unlock" : "Lock"}
        title={row.locked ? "Unlock" : "Lock"}
        onClick={() => onToggleLock(row.id, !row.locked)}
      >
        {row.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
