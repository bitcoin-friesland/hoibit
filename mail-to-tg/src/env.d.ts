// Secret set with `wrangler secret put`; wrangler types only sees bindings from wrangler.toml.
interface Env {
  TELEGRAM_TOKEN: string;
}
