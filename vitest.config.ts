import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/odonto_test",
      AUTH_MODE: "local",
      FIELD_ENCRYPTION_KEY: "test-key-test-key-test-key-test-key",
      MEDIA_DIR: ".data/test-media",
    },
  },
});
