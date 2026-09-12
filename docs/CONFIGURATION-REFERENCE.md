# Configuration reference: hoibit

Names-only source inventory checked 2026-09-12 at `05c014213364`.
This is not a dump of configured values or proof that a deployment has them.

## Source references

The table lists literal environment reads found in checked-in application,
function and tooling source, excluding test files. Some entries are optional,
provider-injected metadata or developer-tool overrides. Read the consuming code
for defaults and requiredness. Dynamic names, destructured bindings, hard-coded
configuration and externally configured secrets may not appear; absence here does
not prove absence of an integration. Up to three source examples are linked per name.

| Name | Consuming source | Exposure guidance |
| --- | --- | --- |
| `DB` | [crm-api/index.js](../crm-api/index.js) | Worker binding; use a local test resource |
| `SESSIONS` | [telegram-crm/index.js](../telegram-crm/index.js) | Worker binding; use a local test resource |
| `crmApi` | [telegram-crm/wrangler.toml](../telegram-crm/wrangler.toml) | Worker binding; use a local test resource |
| `TELEGRAM_TOKEN` | [telegram-crm/index.js](../telegram-crm/index.js), [mail-to-tg/index.js](../mail-to-tg/index.js) | Runtime/tooling input; inspect consumer, keep credentials server-side |
| `TELEGRAM_CHAT_ID` | [mail-to-tg/index.js](../mail-to-tg/index.js) | Runtime/tooling input; inspect consumer, keep credentials server-side |

## Safe setup and changes

1. Identify the exact app/function and its approved development environment before obtaining any values.
2. Keep credentials in the approved local secret file or provider secret store, never in docs, commits, screenshots or task transcripts. Do not copy a tracked environment file into a new repository.
3. Browser-prefixed values are public. Server credentials must not enter the browser bundle, and hiding a URL or public key is not an authorization control.
4. Use synthetic fixtures and sandbox providers. Check scripts and configuration for remote targets before starting an integration test; do not assume that localhost means all dependencies are local.
5. Record changed names, requiredness, owner and validation evidence when adding configuration. Do not rotate keys, change provider settings or modify production data as incidental documentation work.

Missing-value errors should name the missing setting without printing its value.
Request only the narrow access needed. If an existing file contains credentials or
personal records, do not propagate them; raise the concern privately with the owner.
