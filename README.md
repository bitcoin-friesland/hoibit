# HoiBit CRM

Cloudflare Workers integrations for a community CRM: an HTTP API, a Telegram
conversation bot and an inbound-email-to-Telegram worker. Source access and this
public repository do not grant access to CRM records or permission to message users.

## Start here

- [Agent rules](AGENTS.md) and [source-linked onboarding](docs/AGENT-START.md)
- [Configuration names and bindings](docs/CONFIGURATION-REFERENCE.md)
- [Task handoff](docs/HANDOFF-TEMPLATE.md)
- [Existing integer-ID conventions](.crm-rules.md)

## System map

| Component | Entry | Role |
| --- | --- | --- |
| CRM API | [crm-api/index.js](crm-api/index.js) | HTTP handlers using a D1 database binding |
| Telegram bot | [telegram-crm/index.js](telegram-crm/index.js) | Conversation flows with KV session storage and CRM service calls |
| Email forwarding | [mail-to-tg/index.js](mail-to-tg/index.js) | Parses inbound mail and forwards an excerpt to Telegram |
| Schema | [schema.sql](schema.sql) | Database structure and initialization material; inspect before use |

Each worker has its own `wrangler.toml`. The two package manifests inside worker
directories are independent of the root manifest. Deployment accounts, routes and
currently deployed versions have not been verified by this documentation pass.

## Development status

There is no root build or development command. The `test` scripts are deliberate
failure placeholders, not functioning tests. No dependency lockfile is committed.
Before executing workers, establish an approved pinned toolchain and isolated
local D1/KV plus mock Telegram/CRM transports. Do not execute `schema.sql` against
a remote database or register a production webhook as an onboarding step.

## Verification and release boundaries

Future changes need executable tests for caller authorization, malformed input,
integer IDs, duplicate events, expired sessions and upstream failures. Review email
and API logging for personal data. Source-level inspection here is not a security
certification, successful message-delivery test or production-readiness claim.

Keep test data fictional. Do not publish customer/contact records, bot tokens,
recipient identifiers or private service URLs. Prepare a branch and PR for human
review; deployment, database changes and real messages require separate approval.
