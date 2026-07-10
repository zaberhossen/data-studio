"use client";

/**
 * ExecutionModeToggle — chooses where an advanced (IR) query runs (M5):
 *
 *   • Auto     → let `chooseExecution` decide (pushdown for a live DB when the
 *                query aggregates; local otherwise).
 *   • Local    → force DuckDB-in-browser over the resident dataset slice.
 *   • Pushdown → force execution on the live database (server-side compile+run).
 *
 * It's a thin segmented control over the workspace's execution setting. Pushdown
 * is disabled unless the active source is a live DB that the `/run` endpoint
 * supports; in Auto, a small hint shows which way it will actually go.
 */

import * as React from "react";
import { Cloud, Laptop, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ExecutionSetting } from "@/hooks/useQueryWorkspace";
import type { ExecutionMode } from "@/lib/types/query";

interface Props {
  value: ExecutionSetting;
  onChange: (mode: ExecutionSetting) => void;
  /** The mode a run will ACTUALLY use (drives the Auto hint). */
  resolved: ExecutionMode;
  /** Whether the active source can push down (a live postgres/mysql DB). */
  canPushdown: boolean;
}

export function ExecutionModeToggle({ value, onChange, resolved, canPushdown }: Props) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        role="group"
        aria-label="Execution mode"
        className="inline-flex rounded-md border border-border bg-muted p-0.5"
      >
        <Seg
          active={value === "auto"}
          onClick={() => onChange("auto")}
          icon={<Wand2 className="h-3.5 w-3.5" />}
          label="Auto"
        />
        <Seg
          active={value === "local"}
          onClick={() => onChange("local")}
          icon={<Laptop className="h-3.5 w-3.5" />}
          label="Local"
        />
        <Seg
          active={value === "pushdown"}
          disabled={!canPushdown}
          onClick={() => onChange("pushdown")}
          icon={<Cloud className="h-3.5 w-3.5" />}
          label="Pushdown"
          title={
            canPushdown
              ? "Run the query on the live database"
              : "Pushdown needs a live Postgres/MySQL source"
          }
        />
      </div>
      {value === "auto" && (
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          → {resolved === "pushdown" ? "pushdown" : "local"}
        </span>
      )}
    </div>
  );
}

function Seg({
  active,
  disabled,
  onClick,
  icon,
  label,
  title,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  title?: string;
}) {
  return (
    <Button
      type="button"
      aria-pressed={active}
      variant={active ? "secondary" : "ghost"}
      size="sm"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className="h-7 gap-1.5"
    >
      {icon}
      {label}
    </Button>
  );
}
