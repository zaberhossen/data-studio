"use client";

/**
 * CreateDashboardDialog — the create-time Page vs Canvas choice.
 *
 * A dashboard's TYPE is picked at creation (the product's two mental models):
 *   • Page   — a structured, responsive grid document (Metabase-style).
 *   • Canvas — a free-form design surface (Figma-style: absolute placement,
 *              rotation, decoration elements; frames arrive in M13-B).
 *
 * The underlying `layoutMode` stays losslessly convertible afterward via the
 * dashboard's ⋯ menu — this dialog just makes the choice explicit up front
 * instead of a mid-flight toggle.
 */

import * as React from "react";
import { LayoutGrid, PenTool } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { LayoutMode } from "@/lib/types/dashboard";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { name: string; layoutMode: LayoutMode }) => Promise<void> | void;
}

const TYPES: Array<{
  mode: LayoutMode;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    mode: "grid",
    title: "Page",
    description: "A structured grid of cards that reflows responsively. Best for everyday reporting.",
    icon: LayoutGrid,
  },
  {
    mode: "canvas",
    title: "Canvas",
    description: "A free-form design surface: place, resize and rotate anything anywhere.",
    icon: PenTool,
  },
];

export function CreateDashboardDialog({ open, onOpenChange, onCreate }: Props) {
  const [name, setName] = React.useState("");
  const [mode, setMode] = React.useState<LayoutMode>("grid");
  const [creating, setCreating] = React.useState(false);

  // Reset per open so a reopened dialog doesn't carry the last submission.
  const prevOpen = React.useRef(open);
  // eslint-disable-next-line react-hooks/refs -- prev-prop tracker for the documented set-state-during-render reset pattern
  if (open !== prevOpen.current) {
    // eslint-disable-next-line react-hooks/refs -- resetting the tracker in the same render-time comparison
    prevOpen.current = open;
    if (open) {
      setName("");
      setMode("grid");
      setCreating(false);
    }
  }

  const submit = async () => {
    setCreating(true);
    try {
      await onCreate({ name: name.trim() || "Untitled dashboard", layoutMode: mode });
      onOpenChange(false);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New dashboard</DialogTitle>
          <DialogDescription>
            Pick how you want to lay it out — you can convert between the two later.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Dashboard type">
            {TYPES.map((t) => {
              const active = mode === t.mode;
              return (
                <button
                  key={t.mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setMode(t.mode)}
                  className={cn(
                    "flex flex-col items-start gap-1.5 rounded-md border p-3 text-left transition-colors",
                    active
                      ? "border-primary bg-primary/5"
                      : "border-strong bg-surface-100 hover:border-stronger",
                  )}
                >
                  <t.icon
                    className={cn("h-4 w-4", active ? "text-primary" : "text-muted-foreground")}
                  />
                  <span className="text-sm font-medium">{t.title}</span>
                  <span className="text-xs leading-snug text-muted-foreground">
                    {t.description}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dashboard-name">Name</Label>
            <Input
              id="dashboard-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled dashboard"
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              autoFocus
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={creating} onClick={() => void submit()}>
            {creating ? "Creating…" : `Create ${mode === "grid" ? "page" : "canvas"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
