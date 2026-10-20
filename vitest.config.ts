import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./tests/globalSetup.ts"],
    setupFiles: ["./tests/setupEnv.ts"],
    // Shared SQLite test.db cannot safely be reset by parallel files.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "file:./prisma/test.db",
    },
  },
});
