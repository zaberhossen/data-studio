// Flat ESLint config (ESLint 9 + Next 16). `next lint` was removed in Next 16,
// so linting now runs through the ESLint CLI (`pnpm lint` → `eslint .`).
// `eslint-config-next` ships native flat-config arrays; `core-web-vitals`
// spreads in the base config (react, react-hooks, import, jsx-a11y,
// typescript-eslint) plus the Core Web Vitals rules.
import next from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "src/wasm/pkg/**", // generated wasm-pack glue
      "next-env.d.ts",
    ],
  },
  ...next,
  ...typescript,
];

export default config;
