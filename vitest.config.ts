import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
