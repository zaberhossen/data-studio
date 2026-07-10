import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Pure-logic unit tests (adapters). jsdom isn't needed here.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
