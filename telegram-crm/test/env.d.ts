// Test-only bindings from vitest.config.ts: a D1 for crm-api and its migrations.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
