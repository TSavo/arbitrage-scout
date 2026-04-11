import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30000,
    pool: "forks",
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
