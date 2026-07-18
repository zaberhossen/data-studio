/** @type {import('next').NextConfig} */

// ---------------------------------------------------------------------------
// Content-Security-Policy
//
// The app runs heavy client-side compute (Rust→WASM + DuckDB-WASM on Web
// Workers), renders user-supplied image URLs (canvas image elements, geo maps),
// and — for http-file / rest-api sources — fetches arbitrary origins from the
// browser. The policy below is written to accommodate exactly those needs and
// nothing more:
//
//   script-src  'unsafe-inline' — Next.js injects inline hydration/bootstrap
//               scripts (no nonce pipeline here); 'wasm-unsafe-eval' + blob:
//               for the WASM engines and worker bootstrap; 'unsafe-eval' for
//               DuckDB-WASM / Arrow codegen.
//   worker-src / child-src blob: — workers are instantiated from blob URLs.
//   connect-src https: wss: — client-side connectors fetch live http/rest
//               sources and DuckDB streams from arbitrary https origins.
//   img-src data: blob: https: — canvas image elements + map tiles.
//   style-src  'unsafe-inline' — Tailwind/Next inject inline <style>.
//   object-src 'none' / base-uri 'self' / form-action 'self' — hardening.
//
// frame-ancestors is handled SEPARATELY (see headers()) so its clickjacking
// protection stays enforcing per-route regardless of the content-CSP mode.
//
// Enforcement is OPT-IN. Because a mis-scoped directive would break rendering
// and this build ships without a browser to verify it, the content policy is
// emitted as `Content-Security-Policy-Report-Only` by default (violations log
// to the console, nothing is blocked). Set `CSP_ENFORCE=1` once verified in a
// browser to promote it to the enforcing `Content-Security-Policy` header.
// ---------------------------------------------------------------------------

/** Content directives (everything except frame-ancestors), as one policy string. */
function contentCspDirectives() {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "connect-src 'self' https: wss: blob: data:",
    "form-action 'self'",
  ].join("; ");
}

const CSP_ENFORCING = process.env.CSP_ENFORCE === "1" || process.env.CSP_ENFORCE === "true";

/** Baseline hardening headers — safe on every route, no browser verification needed. */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];

/** The content-CSP header (enforcing or report-only, per CSP_ENFORCE). */
function contentCspHeader() {
  return {
    key: CSP_ENFORCING ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only",
    value: contentCspDirectives(),
  };
}

const nextConfig = {
  reactStrictMode: true,

  // Frame policy: every route refuses to be framed (clickjacking defense) EXCEPT
  // the chrome-less embed view, which is meant to live in an <iframe>. The global
  // rule uses a negative lookahead so it never also stamps X-Frame-Options: DENY
  // onto /embed (that would override frame-ancestors and block the iframe).
  //
  // frame-ancestors is kept in its OWN enforcing `Content-Security-Policy` header
  // (a page may carry multiple CSP headers; each is enforced independently), so
  // the content policy above can be report-only without weakening framing.
  async headers() {
    const embedAncestors = process.env.EMBED_FRAME_ANCESTORS || "*";
    const content = contentCspHeader();
    return [
      {
        source: "/embed/:token*",
        headers: [
          { key: "Content-Security-Policy", value: `frame-ancestors ${embedAncestors};` },
          content,
          ...SECURITY_HEADERS,
        ],
      },
      {
        source: "/((?!embed/).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none';" },
          content,
          ...SECURITY_HEADERS,
        ],
      },
    ];
  },

  // Bundler note: Turbopack (the Next 16 default for `next dev` and `next build`)
  // handles the Rust/WASM engine natively — async WebAssembly and `.wasm` assets
  // work out of the box, and the worker→WASM fetch is unblocked by Next 16.2's
  // Web Worker Origin fix. The old `webpack()` block that enabled
  // `asyncWebAssembly`/`layers` and emitted `.wasm` as `asset/resource` is
  // therefore no longer needed. If we ever fall back to webpack via
  // `next build --webpack`, that block must be restored.
};

export default nextConfig;
