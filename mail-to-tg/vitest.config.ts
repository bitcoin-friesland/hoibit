import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      // The outbox Durable Object reads these from its own env, not from the env a test passes in.
      miniflare: { bindings: { TELEGRAM_TOKEN: "test-token", TELEGRAM_CHAT_ID: "-100123" } }
    })
  ]
});
