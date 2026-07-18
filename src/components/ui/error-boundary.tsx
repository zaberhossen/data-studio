"use client";

/**
 * ErrorBoundary — a reusable React error boundary (the only reliable way to stop
 * a render-time throw from unmounting an entire subtree). Wrap any island that
 * could crash on malformed input — a widget's chart, a canvas element — so ONE
 * bad tile shows an inline fallback instead of taking down the whole dashboard.
 *
 * `resetKeys` clears the caught error when any key changes (e.g. the widget's
 * result), so a boundary recovers automatically once the offending input is
 * replaced — no manual "try again" needed for the common case.
 */

import * as React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Render prop for the fallback UI; receives the error + a manual reset. */
  fallback: (error: Error, reset: () => void) => React.ReactNode;
  /** When any value here changes between renders, the boundary auto-resets. */
  resetKeys?: unknown[];
  /** Optional side-effect on catch (logging/telemetry). Must not throw. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** True when two resetKeys arrays differ (identity per element). Exported for tests. */
export function keysChanged(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === b) return false;
  if (!a || !b || a.length !== b.length) return true;
  return a.some((v, i) => !Object.is(v, b[i]));
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    try {
      this.props.onError?.(error, info);
    } catch {
      // Telemetry must never break error handling.
    }
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    // Auto-recover once the inputs that likely caused the throw have changed.
    if (this.state.error && keysChanged(prev.resetKeys, this.props.resetKeys)) {
      this.setState({ error: null });
    }
  }

  reset = (): void => this.setState({ error: null });

  render(): React.ReactNode {
    if (this.state.error) return this.props.fallback(this.state.error, this.reset);
    return this.props.children;
  }
}
