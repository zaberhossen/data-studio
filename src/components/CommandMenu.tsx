"use client";

/**
 * CommandMenu — a ⌘K / Ctrl+K command palette for quick navigation and actions.
 *
 * Dependency-free (no cmdk): a top-anchored overlay with a filtered, keyboard-
 * navigable list. Opens on ⌘K globally; closes on Escape or backdrop click.
 * Actions cover section navigation, starting a new query, and toggling the theme.
 *
 * tokens: styled entirely with the app's design tokens (popover/accent/brand).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Command as CommandIcon,
  Database,
  FilePlus2,
  Home,
  LayoutDashboard,
  Moon,
  Save,
  ScrollText,
  ShieldCheck,
  Table2,
  Terminal,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/app/(app)/WorkspaceProvider";

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void;
}

interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle("dark");
  try {
    localStorage.setItem("theme", isDark ? "dark" : "light");
  } catch {
    /* storage unavailable */
  }
}

export function CommandMenu({ open, onOpenChange }: CommandMenuProps) {
  const router = useRouter();
  const { newQuery } = useWorkspace();
  const { data: session } = useSession();
  const role = session?.user?.role ?? null;
  const isAdmin = role === "owner" || role === "admin";
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Global ⌘K / Ctrl+K to open.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange]);

  // Reset + focus when opened.
  React.useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the search query and selection each time the menu opens
      setQuery("");
      setActiveIndex(0);
      // focus after paint
      const t = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  const items = React.useMemo<CommandItem[]>(() => {
    const nav = (href: string) => () => {
      router.push(href);
      onOpenChange(false);
    };
    return [
      {
        id: "new-query",
        label: "New query",
        hint: "Action",
        icon: FilePlus2,
        run: () => {
          newQuery();
          router.push("/sql");
          onOpenChange(false);
        },
      },
      { id: "go-home", label: "Go to Home", hint: "Navigate", icon: Home, run: nav("/") },
      { id: "go-editor", label: "Go to Table Editor", hint: "Navigate", icon: Table2, run: nav("/editor") },
      { id: "go-sql", label: "Go to SQL Editor", hint: "Navigate", icon: Terminal, run: nav("/sql") },
      { id: "go-sources", label: "Go to Data sources", hint: "Navigate", icon: Database, run: nav("/sources") },
      { id: "go-saved", label: "Go to Saved queries", hint: "Navigate", icon: Save, run: nav("/saved") },
      { id: "go-logs", label: "Go to Logs", hint: "Navigate", icon: ScrollText, run: nav("/logs") },
      { id: "go-dashboards", label: "Go to Dashboards", hint: "Navigate", icon: LayoutDashboard, run: nav("/dashboards") },
      ...(isAdmin
        ? [
            {
              id: "go-members",
              label: "Go to Members",
              hint: "Navigate",
              icon: Users,
              run: nav("/members"),
            },
            {
              id: "go-audit",
              label: "Go to Audit log",
              hint: "Navigate",
              icon: ShieldCheck,
              run: nav("/audit"),
            },
          ]
        : []),
      {
        id: "toggle-theme",
        label: "Toggle theme",
        hint: "Action",
        icon: Moon,
        run: () => {
          toggleTheme();
          onOpenChange(false);
        },
      },
    ];
  }, [router, newQuery, onOpenChange, isAdmin]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => it.label.toLowerCase().includes(q));
  }, [items, query]);

  // Keep the active index in range as the list filters.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clamp the user-controlled active index back into range as the filtered list shrinks
    setActiveIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onOpenChange(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % Math.max(1, filtered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + filtered.length) % Math.max(1, filtered.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[activeIndex]?.run();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command menu"
    >
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[2px] animate-in fade-in"
      />
      <div
        className="relative w-full max-w-lg overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl animate-in fade-in zoom-in-95"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <CommandIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search…"
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Command input"
          />
          <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>

        <ul className="max-h-80 overflow-auto p-1.5">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              No results
            </li>
          ) : (
            filtered.map((it, i) => {
              const Icon = it.icon;
              const isActive = i === activeIndex;
              return (
                <li key={it.id}>
                  <button
                    type="button"
                    onClick={() => it.run()}
                    onMouseMove={() => setActiveIndex(i)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                      isActive
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1">{it.label}</span>
                    {it.hint && (
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {it.hint}
                      </span>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
