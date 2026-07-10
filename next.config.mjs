/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Frame policy: every route refuses to be framed (clickjacking defense) EXCEPT
  // the chrome-less embed view, which is meant to live in an <iframe>. The global
  // rule uses a negative lookahead so it never also stamps X-Frame-Options: DENY
  // onto /embed (that would override frame-ancestors and block the iframe).
  async headers() {
    const embedAncestors = process.env.EMBED_FRAME_ANCESTORS || "*";
    return [
      {
        source: "/embed/:token*",
        headers: [
          { key: "Content-Security-Policy", value: `frame-ancestors ${embedAncestors};` },
        ],
      },
      {
        source: "/((?!embed/).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none';" },
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
