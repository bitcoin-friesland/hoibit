import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run telegram-crm against the real crm-api code with a local D1 (see test/harness.js).
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "../crm-api/migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          d1Databases: ["DB"],
          // The real crm-api service is not available here; the harness passes its own crmApi.
          serviceBindings: { crmApi: () => new Response("crm-api is stubbed in tests", { status: 500 }) },
          bindings: { TEST_MIGRATIONS: migrations }
        }
      })
    ],
    test: { setupFiles: ["./test/apply-migrations.js"] }
  };
});
