# hoibit

Cloudflare Workers behind the Bitcoin Friesland community CRM: a Telegram bot for the team, the API that owns the database, and a worker that forwards inbound email to Telegram.

| Worker                        | What it does                                                                                                                                                                                                                                                              | Bindings                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [crm-api](crm-api/)           | Owns the D1 database `crm`. Exposes its methods over [RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/) (`CrmApi extends WorkerEntrypoint`), no public HTTP. Writes an `audit_log` row for every change.                                                  | `DB` (D1)                                                            |
| [telegram-crm](telegram-crm/) | Telegram webhook. Team members add contacts and organizations (`/newcontact`, `/neworg`), log conversations (`/logconversation`) and admins manage the team (`/teammember`, `/invite`). Looks up businesses in OpenStreetMap. Sessions live in a Durable Object per user. | `crmApi` (service → crm-api), `CHATS` (Durable Object `ChatSession`) |
| [mail-to-tg](mail-to-tg/)     | Email Routing worker. Posts each incoming email to the team's Telegram group; never drops a message silently.                                                                                                                                                             | none                                                                 |

## Requirements

- Node.js 24 (the version CI uses)
- npm 11. npm 10.9 crashes installing Vitest (`Cannot read properties of null (reading 'edgesOut')`); use `npx -y npm@11 install` if your npm is older.

Wrangler is a dev dependency of each worker, so there is nothing to install globally.

## Run and test

Each worker is its own npm package. From the repository root:

```sh
npm ci                     # Prettier for the whole repo
cd crm-api && npm ci       # repeat for telegram-crm and mail-to-tg
npm test                   # Vitest in the Workers runtime, local D1 with all migrations applied
npm run typecheck          # wrangler types --check && tsc
npm run dev                # wrangler dev on localhost
```

Format before you commit: `npm run format` in the root (`npm run format:check` is what CI runs).

telegram-crm calls crm-api over a service binding, so its types are generated from both configs: `npm run types` in `telegram-crm/` runs `wrangler types -c wrangler.toml -c ../crm-api/wrangler.toml`.

## Configuration

Secrets are set with `npx wrangler secret put <NAME>` and never committed. Their names are declared in each worker's `src/env.d.ts`.

| Worker       | Secret                    | Purpose                                                                                                                                                              |
| ------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| telegram-crm | `TELEGRAM_TOKEN`          | Bot API token from BotFather.                                                                                                                                        |
| telegram-crm | `TELEGRAM_WEBHOOK_SECRET` | Compared with the `X-Telegram-Bot-Api-Secret-Token` header; without a match the bot answers 401. Set the same value as `secret_token` when registering the webhook.  |
| mail-to-tg   | `TELEGRAM_TOKEN`          | Bot API token used to post to the group.                                                                                                                             |
| mail-to-tg   | `FALLBACK_EMAIL`          | Optional. A verified Email Routing destination that receives the email when Telegram refuses it. Without it the worker throws, so the failure shows in Workers Logs. |

mail-to-tg posts to the chat in `TELEGRAM_CHAT_ID` in [mail-to-tg/wrangler.toml](mail-to-tg/wrangler.toml).

## Database

The schema lives in [crm-api/migrations/](crm-api/migrations/). Change it by adding a migration, never by editing one that has been applied; [.crm-rules.md](.crm-rules.md) has the details, including why `team_members.telegram_id` and `audit_log.record_id` must be bound as strings.

## Deployment

Workers Builds deploys a worker when a commit that changes its folder lands on `main`. Pull requests run CI (format check, typecheck, tests) but do not deploy. Remote D1 migrations are applied by hand with `npx wrangler d1 migrations apply crm --remote`, after the code that needs them has been reviewed.

Because telegram-crm calls crm-api over RPC, a change to a crm-api method must be live before the telegram-crm change that uses it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Public domain under [The Unlicense](LICENSE).
