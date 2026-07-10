"use client";

/**
 * ThemeToggle — cycles the app theme between system → light → dark and persists
 * the choice under localStorage "theme".
 *
 * The initial `.dark` class is set pre-hydration by the inline script in
 * `layout.tsx`. This component mirrors + mutates that state. In "system" mode it
 * follows the OS via `matchMedia`, so the class stays correct if the OS flips.
 *
 * shadcn primitives: Button (variant="ghost", size="icon").
 * States: not-yet-mounted (placeholder to avoid hydration mismatch), then one of
 * system / light / dark.
 */

import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

type Theme = "light" | "dark" | "system";

const ORDER: Theme[] = ["system", "light", "dark"];

function systemPrefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Apply the resolved theme to <html>. */
function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

export function ThemeToggle() {
  const [theme, setTheme] = React.useState<Theme>("system");
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    let stored: Theme = "system";
    try {
      const t = localStorage.getItem("theme");
      if (t === "light" || t === "dark" || t === "system") stored = t;
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate theme from localStorage on mount (client-only) to avoid an SSR mismatch
    setTheme(stored);
    setMounted(true);
  }, []);

  // While in "system" mode, keep the class in sync with OS changes.
  React.useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const cycle = React.useCallback(() => {
    setTheme((prev) => {
      const next = ORDER[(ORDER.indexOf(prev) + 1) % ORDER.length];
      applyTheme(next);
      try {
        localStorage.setItem("theme", next);
      } catch {
        /* storage unavailable — theme still applies for this session */
      }
      return next;
    });
  }, []);

  const label =
    theme === "system"
      ? "Theme: system"
      : theme === "light"
        ? "Theme: light"
        : "Theme: dark";

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label={label}
      title={label}
    >
      {/* Render an icon only after mount to keep SSR/CSR markup identical. */}
      {mounted ? (
        theme === "system" ? (
          <Monitor className="h-4 w-4" />
        ) : theme === "light" ? (
          <Sun className="h-4 w-4" />
        ) : (
          <Moon className="h-4 w-4" />
        )
      ) : (
        <span className="h-4 w-4" />
      )}
    </Button>
  );
}
