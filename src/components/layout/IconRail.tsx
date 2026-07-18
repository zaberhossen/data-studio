"use client";

/**
 * IconRail — the primary navigation rail (Supabase-style): a thin, always-visible
 * icon-only strip on the far left. Route-driven — each item is a `next/link`, the
 * active one derived from `usePathname()`. The brand mark now lives in AppHeader;
 * the rail is nav + theme/settings only.
 *
 * shadcn primitives / tokens: composes ThemeToggle; links styled with tokens.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Database,
  LayoutDashboard,
  ScrollText,
  Settings,
  ShieldCheck,
  Save,
  Table2,
  Terminal,
  Home,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./ThemeToggle";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** When true, only rendered for org owners/admins. */
  adminOnly?: boolean;
}

export const NAV: NavItem[] = [
  { href: "/", label: "Home", icon: Home },
  { href: "/editor", label: "Table Editor", icon: Table2 },
  { href: "/sql", label: "SQL Editor", icon: Terminal },
  { href: "/sources", label: "Data sources", icon: Database },
  { href: "/saved", label: "Saved queries", icon: Save },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/dashboards", label: "Dashboards", icon: LayoutDashboard },
  { href: "/audit", label: "Audit log", icon: ShieldCheck, adminOnly: true },
];

/** Active when the path equals the href, or (for non-root hrefs) is nested under it. */
function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function IconRail() {
  const pathname = usePathname() ?? "/";
  const { data: session } = useSession();
  const role = session?.user?.role ?? null;
  const isAdmin = role === "owner" || role === "admin";
  const items = NAV.filter((item) => !item.adminOnly || isAdmin);

  return (
    <nav
      aria-label="Primary navigation"
      className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-2"
    >
      <ul className="flex flex-1 flex-col items-center gap-1 pt-1">
        {items.map((item) => {
          const Icon = item.icon;
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href} className="relative">
              {active && (
                <span
                  aria-hidden
                  className="absolute left-[-8px] top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-brand"
                />
              )}
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                title={item.label}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
                  active
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon className="h-[18px] w-[18px]" />
                <span className="sr-only">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col items-center gap-1">
        <ThemeToggle />
        <button
          type="button"
          title="Settings"
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Settings className="h-[18px] w-[18px]" />
          <span className="sr-only">Settings</span>
        </button>
      </div>
    </nav>
  );
}
