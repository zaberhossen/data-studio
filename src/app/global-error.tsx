"use client";

/**
 * Root error boundary — the last line of defense. Next.js renders this only when
 * the ROOT layout itself throws, so it must supply its own <html>/<body> and can
 * rely on nothing from the app (tokens/fonts may be absent) — hence inline styles.
 */

import * as React from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#1c1c1c",
          color: "#ededed",
        }}
      >
        <div style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Something went wrong</h1>
          <p style={{ fontSize: 13, opacity: 0.8, marginTop: 8 }}>
            {error.message || "An unexpected error occurred."}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 16,
              padding: "8px 16px",
              fontSize: 13,
              borderRadius: 6,
              border: "1px solid #3ecf8e",
              background: "transparent",
              color: "#3ecf8e",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
