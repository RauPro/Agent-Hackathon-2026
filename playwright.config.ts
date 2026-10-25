import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:3100",
    viewport: { width: 390, height: 844 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node tests/e2e/mock-openai.mjs",
      url: "http://127.0.0.1:3101/health",
      reuseExistingServer: false,
    },
    {
      command: "node tests/e2e/mock-google.mjs",
      url: "http://127.0.0.1:3102/health",
      reuseExistingServer: false,
    },
    {
      command: "node tests/e2e/mock-exa.mjs",
      url: "http://127.0.0.1:3103/health",
      reuseExistingServer: false,
    },
    {
      command: "npm run dev -- --port 3100",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: false,
      timeout: 60000,
      env: {
        DATABASE_PATH: join(tmpdir(), `sf-sidekick-e2e-${process.pid}.sqlite`),
        OPENAI_API_KEY: "test-key-not-a-secret",
        OPENAI_BASE_URL: "http://127.0.0.1:3101/v1",
        EXA_API_KEY: "test-exa-not-a-secret",
        EXA_TEST_BASE_URL: "http://127.0.0.1:3103",
        DISCOVERY_DAILY_RUN_LIMIT: "100",
        NODE_OPTIONS: `--import "${join(process.cwd(), "tests/e2e/loopback-only.mjs")}"`,
        GOOGLE_CLIENT_ID: "test-google-client",
        GOOGLE_CLIENT_SECRET: "test-google-secret",
        GOOGLE_REDIRECT_URI: "http://127.0.0.1:3100/api/calendar/callback",
        TOKEN_ENCRYPTION_KEY: "b".repeat(64),
        GOOGLE_TEST_BASE_URL: "http://127.0.0.1:3102",
      },
    },
  ],
});
