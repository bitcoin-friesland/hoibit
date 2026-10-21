// Secrets set with `wrangler secret put`; wrangler types only sees bindings from wrangler.toml.
interface Env {
  TELEGRAM_TOKEN: string;
  // Optional verified Email Routing destination that gets the email when Telegram refuses it.
  FALLBACK_EMAIL?: string;
}
